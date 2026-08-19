"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 懒加载 + 记忆化: 面板前端 (CSS + 全部 client 脚本约 200KB+) 只在首次渲染
//   面板时读盘并拼接, 不在模块加载 / 扩展激活关键路径上同步读入、常驻。
const EA_CONFIG_CLIENT_FILES = require("./ea-config-client");
let _eaConfigCssCache = null;
let _eaConfigClientCache = null;
function _eaConfigCss() {
  if (_eaConfigCssCache === null) {
    _eaConfigCssCache = fs.readFileSync(
      path.join(__dirname, "ea-config.css"),
      "utf8",
    );
  }
  return _eaConfigCssCache;
}
function _eaConfigClient() {
  if (_eaConfigClientCache === null) {
    _eaConfigClientCache = EA_CONFIG_CLIENT_FILES.map((file) =>
      fs.readFileSync(path.join(__dirname, file), "utf8"),
    ).join("");
  }
  return _eaConfigClientCache;
}

function _genNonce() {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function _escapeHtml(value) {
  if (!value) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function _desktopBridgeScript(enabled) {
  if (!enabled) return "";
  return `
/* DAO_DESKTOP_CONTROL_BRIDGE · narrow replacement for acquireVsCodeApi */
(function () {
  var host = window.daoControlHost;
  if (!host || typeof host !== "object") return;
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) {
        if (!message || typeof message.type !== "string") return;
        if (message.type === "openExternal") {
          return host.openExternal(message.url);
        }
        if (message.type === "openConfigJson") {
          return host.openConfig();
        }
        if (message.type === "copyHandoff") {
          return host.copyText(message.content);
        }
        if (message.type === "saveHandoff") {
          return host.saveHandoff(message.content, message.filename);
        }
        // Codex/IDE workspace mutations intentionally remain unavailable in Desktop.
        return undefined;
      }
    };
  };
})();
`;
}

function getEaConfigHtml(port, nonce, opts) {
  const N = nonce || _genNonce();
  const proxyPort = port || 0;
  // 归一(dao-one)折入模式: 复用二合一本源「🌐 内网穿透」板块(单隧道直达已暴露 /v1),
  //   故本面板隐藏自带的 ⑤ 内网穿透 子页, 不重复起第二条 cloudflared 隧道 (道并行而不相悖)。
  const foldBridge = !!(opts && opts.foldBridge);
  const clientScript = _eaConfigClient()
    .replace("__DAO_PORT__", String(proxyPort))
    .replace("__DAO_FOLD__", foldBridge ? "true" : "false");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${N}'; connect-src http://127.0.0.1:* http://localhost:*; img-src data:;">
<style>${_eaConfigCss()}</style>
</head>
<body data-port="${proxyPort}">
  <!-- ── 三模块 Tab 栏 ── -->
  <div class="dao-tabs">
    <button class="dao-tab active" data-pane="paneEssence">① 本源观照</button>
    <button class="dao-tab" data-pane="paneProvider">② 渠道配置</button>
    <button class="dao-tab" data-pane="paneRouter">③ 模型路由</button>
    <button class="dao-tab" data-pane="paneRevproxy">④ 模型反代</button>
    <button class="dao-tab" data-pane="paneBridge">⑤ 内网穿透</button>
    <button class="dao-tab" data-pane="paneProtocolBridge">⑥ 协议中转站</button>
    <button class="dao-tab" data-pane="paneCustomModel">⑦ 自定义模型</button>
    <button class="dao-tab" data-pane="paneCodex">⑧ Codex 热路由</button>
    <button class="dao-tab" data-pane="paneObs">⑨ 观测台 <span id="obsBadge" style="display:none;background:#e51400;color:#fff;border-radius:8px;padding:0 5px;font-size:9px"></span></button>
  </div>

  <!-- ① 本源观照 (IDE 左侧复刻 · 道/官/编 + 经文 + 本源体池 · 与左侧完全一致) -->
  <div class="dao-pane active" id="paneEssence">
    <div style="display:flex;align-items:center;gap:4px;padding:4px 2px;border-bottom:1px solid rgba(128,128,128,0.18);flex-wrap:wrap">
      <span id="e1Dots" title="Proxy·Capture·Mode" style="width:8px;height:8px;border-radius:50%;background:rgba(128,128,128,0.4);display:inline-block"></span>
      <button class="btn" id="e1Dao" title="FOMO FLOW · 自定义系统提示词" style="padding:2px 8px;font-weight:600">导</button>
      <button class="btn" id="e1Off" title="官方Agent·透传" style="padding:2px 8px">官</button>
      <button class="btn" id="e1Edit" title="编辑注入 SP" style="padding:2px 8px">编</button>
      <select id="e1Canon" title="经藏切换·两经归一·道生一" style="font-size:11px;padding:2px 4px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-dropdown-background,rgba(0,0,0,0.2));color:var(--vscode-dropdown-foreground,var(--vscode-foreground));outline:none;font-family:inherit">
        <option value="laozi+yinfu">引导包 A</option>
        <option value="laozi">引导包 B</option>
        <option value="yinfu">引导包 C</option>
        <option value="windows-agent">引导包 + Windows Agent 工具契约</option>
      </select>
      <span id="e1Badge" style="font-size:10px;opacity:0.6"></span>
      <button class="btn" id="e1Open" style="margin-left:auto" title="在侧栏展开完整本源观照">↗ 侧栏</button>
    </div>
    <div id="e1Stat" style="font-size:10px;opacity:0.65;padding:4px 2px">本源观照 · 加载中…</div>
    <pre id="e1Sp" style="flex:1;overflow:auto;margin:0;padding:8px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));border-radius:4px;opacity:0.55">（待首次对话或加载）</pre>
    <div id="e1EditArea" style="display:none;margin-top:4px">
      <div style="font-size:10px;opacity:0.6;margin:4px 0">编辑自定义系统提示词 · Ctrl+Enter 保存 · Esc 关</div>
      <textarea id="e1EditText" placeholder="编辑注入 LLM 的系统提示词 · 保存后下次对话生效" style="width:100%;min-height:140px;box-sizing:border-box;font-size:11px;font-family:var(--vscode-editor-font-family,monospace);padding:6px;border:1px solid rgba(128,128,128,0.3);border-radius:4px;background:var(--vscode-input-background,rgba(0,0,0,0.12));color:var(--vscode-input-foreground,var(--vscode-foreground));outline:none;resize:vertical"></textarea>
      <div style="display:flex;gap:4px;margin-top:4px;align-items:center">
        <button class="btn add" id="e1Save" title="保存注入 (Ctrl+Enter)">✔ 注入</button>
        <button class="btn" id="e1Reload" title="重载当前 LLM 实收 SP (不保存)">载</button>
        <button class="btn" id="e1Reset" title="清除自定义系统提示词">✖ 重置</button>
        <span id="e1EditStatus" style="font-size:10px;opacity:0.6"></span>
      </div>
    </div>
  </div>

  <!-- ② 渠道配置 (CC-Switch 风) -->
  <div class="dao-pane" id="paneProvider">
    <!-- 预设快加 (cc-switch 预设库) -->
    <div class="provider-bar" style="margin-bottom:4px">
      <select id="presetSelect" style="flex:1;min-width:120px;padding:3px 6px;font-size:11px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.12));color:var(--vscode-input-foreground,var(--vscode-foreground));font-family:inherit;outline:none">
        <option value="">— 选择预设渠道 (cc-switch) —</option>
      </select>
      <button class="btn add" id="btnApplyPreset" title="填入下方表单">填入预设</button>
      <button class="btn" id="btnRegisterPreset" title="打开该渠道官网/注册页 · 去拿 APIKey">🌐 注册/官网</button>
    </div>
    <!-- Provider 输入 -->
    <div class="provider-bar">
      <input id="provName" placeholder="名称 (如 deepseek)" style="flex:0.5;min-width:60px">
      <input id="provUrl" placeholder="Base URL (如 https://api.deepseek.com)" style="flex:2">
      <input id="provKey" type="password" placeholder="API Key" style="flex:1">
      <select id="provProtocol" title="上游协议 · 自动可识别常见官方地址/模型名" style="font-size:11px;padding:3px 5px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-dropdown-background,rgba(0,0,0,0.2));color:var(--vscode-dropdown-foreground,var(--vscode-foreground));outline:none;font-family:inherit">
        <option value="">协议自动</option>
        <option value="openai-chat">OpenAI Chat</option>
        <option value="openai-responses">Responses</option>
        <option value="anthropic">Anthropic</option>
        <option value="gemini">Gemini</option>
      </select>
      <input id="provModels" list="sharedModelSuggestions" placeholder="模型 (留空=自动识别；可选择或逗号添加)" style="flex:1.2">
      <datalist id="sharedModelSuggestions"></datalist>
      <button class="btn add" id="btnAddProv" title="添加 Provider">+ 添加</button>
      <button class="btn probe" id="btnProbe" title="探测所有 Provider 健康">探测</button>
      <button class="btn" id="btnOpenCfgJson" title="在编辑器中打开 配置.json 文件 · 直接查看/手改全部渠道与路由">📄 配置JSON</button>
    </div>
    <!-- 已配渠道列表 (cc-switch 风) -->
    <div id="channelList" style="flex:1;overflow-y:auto;margin-top:4px"></div>
    <!-- ★ v9.9.270 · Agent 交接指挥文档 (实时更新 · 点击下载) -->
    <div style="border-top:1px solid rgba(128,128,128,0.2);margin-top:6px;padding-top:6px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:11px">📄 Agent 交接指挥文档</span>
        <span style="font-size:10px;opacity:0.55">实时反映当前渠道/路由状态 · 交给官方/任意 Agent 即可热配置一切</span>
        <button class="btn add" id="btnCopyHandoff" style="margin-left:auto" title="一键复制最新交接文档到剪贴板 · 直接粘给本地任意 Agent 即可接管配置">📋 复制最新状态</button>
        <button class="btn" id="btnDownloadHandoff" title="下载 fomo-flow-handoff.md">⬇ 下载 MD</button>
        <button class="btn" id="btnPreviewHandoff" title="预览/刷新文档">预览</button>
      </div>
      <pre id="handoffPreview" style="display:none;max-height:200px;overflow:auto;margin:6px 0 0;padding:8px;font-size:10px;line-height:1.45;white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));border-radius:4px"></pre>
    </div>
  </div>

  <!-- ③ 模型路由 (官方 ↔ 第三方 连线) -->
  <div class="dao-pane" id="paneRouter">
    <!-- v9.9.288 · 1:1 对齐开关 (居中) -->
    <div class="align-bar">
      <button class="align-btn" id="alignToggle" title="1:1 对齐: 把已路由的两侧模型按路由关系重排成水平直线对齐 · 再点一次回退到默认分组排序">⇄ 1:1 对齐</button>
      <span class="align-hint">拖拽 ⋮⋮ 可重排板块/模型</span>
    </div>
    <div id="routeRuntimeBanner" style="margin:0 2px 5px;padding:6px 8px;border:1px solid rgba(107,184,107,0.28);border-radius:4px;font-size:10px;line-height:1.5">当前实际路由 · 尚无请求记录</div>
    <div id="bridgeRouteSync" style="display:none;margin:0 2px 5px;padding:5px 7px;border:1px solid rgba(79,193,255,0.22);border-radius:4px;font-size:10px"></div>
    <!-- 连线图 -->
    <div class="wire-container" id="wireContainer" style="position:relative;">
      <div class="wire-col left" id="leftCol">
        <h3>官方模型</h3>
        <div id="officialModels"></div>
      </div>
      <div class="wire-col right" id="rightCol">
        <h3>外接模型</h3>
        <div id="externalModels"></div>
      </div>
      <svg class="wire-svg" id="wireSvg"></svg>
    </div>
  </div>

  <!-- ④ 模型反代 (反者道之动 · 把已接通模型反向暴露为标准本地端点 · 脱离 Devin Desktop 直调) -->
  <div class="dao-pane" id="paneRevproxy">
    <div style="display:flex;align-items:center;gap:8px;padding:6px 2px;border-bottom:1px solid rgba(128,128,128,0.18);flex-wrap:wrap">
      <label class="rp-switch" title="开启后本地标准端点对外提供服务">
        <input type="checkbox" id="rpEnabled"> <b>启用模型反代</b>
      </label>
      <label class="rp-switch" title="对入站 system 施『本源观照』(剥官方着相归本源) · 默认关=透传你自己的提示">
        <input type="checkbox" id="rpInvert"> 本源观照入站提示
      </label>
      <label class="rp-switch" title="官方直通复用捕获帧时剥净 Cascade 系统提示词 · 反代回包即上游模型本源(Kimi 即 Kimi) · 默认开">
        <input type="checkbox" id="rpIsolate"> 提示词隔离(回归模型本源)
      </label>
      <span id="rpStat" style="font-size:10px;opacity:0.65;margin-left:auto">加载中…</span>
    </div>

    <!-- 安全与缓存: 出站脱敏 + exact-match 缓存 -->
    <div style="display:flex;align-items:center;gap:10px;padding:6px 2px;border-bottom:1px solid rgba(128,128,128,0.12);flex-wrap:wrap">
      <label class="rp-switch" title="发往上游前扫高置信度密钥/凭证(sk-/AKIA/私钥块/JWT 等) · 治于未乱">
        <input type="checkbox" id="rpRedact"> 出站脱敏
      </label>
      <select id="rpRedactMode" title="monitor 只记录 · redact 替换占位符 · block 命中即拒" style="font-size:10px;padding:1px 4px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-dropdown-background,rgba(0,0,0,0.2));color:var(--vscode-dropdown-foreground,var(--vscode-foreground));outline:none">
        <option value="monitor">监控(只记)</option>
        <option value="redact">脱敏(替换)</option>
        <option value="block">拦截(拒绝)</option>
      </select>
      <label class="rp-switch" title="请求 byte 级完全相同则回放缓存响应, 跳过上游($0) · 仅非流式无工具的成功响应" style="margin-left:12px">
        <input type="checkbox" id="rpExactCache"> exact 缓存
      </label>
      <span id="rpExactStat" style="font-size:10px;opacity:0.65">—</span>
    </div>

    <!-- 语义缓存 (三层缓存第二层 · embedding 近似 · 有假阳性风险 · 默认关) -->
    <details style="margin:2px 2px 6px">
      <summary style="font-size:10px;cursor:pointer;opacity:0.8">语义缓存(近似命中 · 需 embeddings 端点) <span id="rpSemStat" style="opacity:0.7">—</span></summary>
      <div style="display:flex;flex-direction:column;gap:5px;padding:6px 4px;border:1px solid rgba(128,128,128,0.18);border-radius:5px;margin-top:4px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <label class="rp-switch" title="语义近似(embedding 余弦≥阈值)则回放 · 跳过上游 · 有假阳性风险, 阈值宜保守">
            <input type="checkbox" id="rpSemCache"> 启用语义缓存
          </label>
          <label style="font-size:10px;opacity:0.85">阈值
            <input type="number" id="rpSemThreshold" min="0" max="1" step="0.01" style="width:56px;font-size:10px;padding:1px 3px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.2));color:var(--vscode-input-foreground,var(--vscode-foreground))">
          </label>
        </div>
        <div style="font-size:9px;opacity:0.6;line-height:1.5">embeddings 端点(OpenAI 兼容 /v1/embeddings)· 命中即跳过上游, 但需先付一次 embedding 调用。阈值越高越保守(默认 0.95)。</div>
        <input type="text" id="rpSemBaseUrl" placeholder="Base URL 如 https://api.openai.com/v1" style="font-size:10px;padding:2px 5px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.2));color:var(--vscode-input-foreground,var(--vscode-foreground))">
        <div style="display:flex;gap:5px">
          <input type="text" id="rpSemModel" placeholder="embedding 模型 如 text-embedding-3-small" style="flex:1;font-size:10px;padding:2px 5px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.2));color:var(--vscode-input-foreground,var(--vscode-foreground))">
          <input type="password" id="rpSemKey" placeholder="API Key" style="width:120px;font-size:10px;padding:2px 5px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.2));color:var(--vscode-input-foreground,var(--vscode-foreground))">
        </div>
        <button class="btn" id="rpSemSave" style="align-self:flex-start;font-size:10px">保存语义缓存配置</button>
      </div>
    </details>

    <div style="font-size:11px;line-height:1.6;padding:6px 2px;opacity:0.85">
      把「② 渠道配置 / ③ 模型路由」里已接通的模型，<b>反向</b>暴露为 <b>OpenAI Chat / Responses</b>、
      <b>Anthropic</b> 与 <b>Gemini</b> 本地端点，脱离 Devin Desktop，供智能家居 / 本地脚本 /
      其他设备以标准 SDK 直接调用。<span style="opacity:0.6">反者道之动。</span>
    </div>

    <!-- 端点信息 -->
    <div style="border:1px solid rgba(128,128,128,0.22);border-radius:6px;padding:8px;margin:4px 2px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:11px">本地端点 Base URL</span>
        <code id="rpEndpoint" style="font-size:11px;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));padding:2px 6px;border-radius:3px">—</code>
        <button class="btn" id="rpCopyEndpoint" title="复制 Base URL">复制</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px">
        <span style="font-weight:600;font-size:11px">API Key</span>
        <code id="rpKey" style="font-size:11px;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));padding:2px 6px;border-radius:3px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</code>
        <button class="btn" id="rpCopyKey" title="复制 API Key">复制</button>
        <button class="btn" id="rpRegenKey" title="重新生成 API Key (旧 key 立即失效)">↻ 重置</button>
      </div>
      <details open style="margin-top:6px">
        <summary style="font-size:10px;cursor:pointer;opacity:0.8">本地中转协议 · 单卡片切换</summary>
        <div class="rp-protocol-bar">
          <button class="btn add rp-proto" data-proto="openai-chat">OpenAI Chat</button>
          <button class="btn rp-proto" data-proto="openai-responses">Responses</button>
          <button class="btn rp-proto" data-proto="anthropic">Anthropic</button>
          <button class="btn rp-proto" data-proto="gemini">Gemini</button>
        </div>
        <div class="rp-protocol-card">
          <b id="rpProtocolTitle">OpenAI Chat Completions</b>
          <code id="rpProtocolEndpoint">—</code>
          <span id="rpProtocolHint">Authorization: Bearer {API Key}</span>
          <button class="btn" id="rpCopyProtocol" style="float:right;margin-top:-2px">复制端点</button>
        </div>
      </details>
    </div>

    <!-- 可反代模型列表 (全量呈现·绿=可用/免费 · 红=配额耗尽 · 琥珀=付费未探测) -->
    <div style="display:flex;align-items:center;gap:6px;padding:6px 2px 2px;flex-wrap:wrap">
      <span style="font-weight:600;font-size:11px">可反代模型 (全量·按家族归组)</span>
      <span id="rpModelCount" style="font-size:10px;opacity:0.6"></span>
      <span id="rpLegend" style="font-size:10px;opacity:0.8;margin-left:6px"></span>
      <button class="btn" id="rpRefresh" style="margin-left:auto" title="刷新可反代模型 + 状态">刷新</button>
    </div>
    <div style="display:flex;align-items:center;gap:4px;padding:2px;flex-wrap:wrap">
      <button class="btn rp-f" data-f="all" title="全部模型">全部</button>
      <button class="btn rp-f" data-f="green" title="可反代(绿)">🟢可用</button>
      <button class="btn rp-f" data-f="red" title="配额耗尽(红)">🔴无配额</button>
      <button class="btn rp-f" data-f="free" title="免费档·恒可反代">免费</button>
      <button class="btn rp-f" data-f="channel" title="经第三方渠道">渠道</button>
      <span style="opacity:0.35">|</span>
      <button class="btn" id="rpExposeAll" title="所有模型全部开启外接(默认态)">☑ 全选外接</button>
      <button class="btn" id="rpExposeNone" title="所有模型全部关闭外接(端点不列不接)">☐ 全不外接</button>
      <input id="rpFilter" placeholder="搜索模型 (uid / 名称 / 厂商)" style="flex:1;min-width:120px;font-size:11px;padding:2px 6px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.2));color:var(--vscode-input-foreground,var(--vscode-foreground))">
    </div>
    <div id="rpModelList" style="flex:1;overflow-y:auto;margin:2px;font-size:11px;min-height:120px"></div>

    <!-- 一键测试 (GLM 等免费模型全链路自测) -->
    <div style="border-top:1px solid rgba(128,128,128,0.2);margin-top:6px;padding-top:6px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:11px">一键自测</span>
        <select id="rpTestProtocol" style="font-size:11px;padding:2px 4px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-dropdown-background,rgba(0,0,0,0.2));color:var(--vscode-dropdown-foreground,var(--vscode-foreground));outline:none;font-family:inherit">
          <option value="openai-chat">OpenAI Chat</option>
          <option value="openai-responses">Responses</option>
          <option value="anthropic">Anthropic</option>
          <option value="gemini">Gemini</option>
        </select>
        <select id="rpTestModel" style="flex:1;min-width:120px;font-size:11px;padding:2px 4px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-dropdown-background,rgba(0,0,0,0.2));color:var(--vscode-dropdown-foreground,var(--vscode-foreground));outline:none;font-family:inherit"></select>
        <select id="rpTestReasoning" title="按所选模型能力自动列出思考强度" style="min-width:88px;font-size:11px;padding:2px 4px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-dropdown-background,rgba(0,0,0,0.2));color:var(--vscode-dropdown-foreground,var(--vscode-foreground));outline:none;font-family:inherit"><option value="off">关闭思考</option></select>
        <input id="rpTestPrompt" placeholder="测试提示词 (默认: 你好)" style="flex:1.4;min-width:120px">
        <button class="btn add" id="rpTestRun" title="经本地端点发一次标准 OpenAI 请求 · 验证全链路">▶ 测试</button>
      </div>
      <pre id="rpTestOut" style="display:none;max-height:200px;overflow:auto;margin:6px 0 0;padding:8px;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));border-radius:4px"></pre>
    </div>

    <!-- ★ v9.9.347 · 模型反代专属 Agent 交接文档 (实时生成 · 面向公网直调链路接管) -->
    <div style="border-top:1px solid rgba(128,128,128,0.2);margin-top:6px;padding-top:6px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:11px">📄 Agent 交接文档 · 模型反代→公网直调</span>
        <span style="font-size:10px;opacity:0.55">实时含公网URL/Key/自愈要点 · 交给本地或云端 Agent 即可接管「反代→内网穿透→公网无感调用」整条链路</span>
        <button class="btn add" id="btnCopyRpHandoff" style="margin-left:auto" title="一键复制最新模型反代交接文档到剪贴板">📋 复制最新状态</button>
        <button class="btn" id="btnDownloadRpHandoff" title="下载 fomo-flow-revproxy-handoff.md">⬇ 下载 MD</button>
        <button class="btn" id="btnPreviewRpHandoff" title="预览/刷新文档">预览</button>
      </div>
      <pre id="rpHandoffPreview" style="display:none;max-height:200px;overflow:auto;margin:6px 0 0;padding:8px;font-size:10px;line-height:1.45;white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));border-radius:4px"></pre>
    </div>
  </div>

  <!-- ⑤ 内网穿透 · DAO Bridge (反者道之动 · 把反代端点直暴公网 · 零账号去中心化 · 公网直调反带模型) -->
  <div class="dao-pane" id="paneBridge">
    ${foldBridge ? `<div style="background:rgba(88,166,255,0.10);border:1px solid rgba(88,166,255,0.28);border-radius:6px;padding:8px 10px;margin:4px 2px;font-size:11px;line-height:1.7;opacity:0.95">
      <b>☯ 归一复用</b> · 本板块公网穿透<b>复用</b>二合一本源「🌐 内网穿透 · DAO Bridge」的<b>同一条</b> cloudflared 隧道——它经<b>单隧道直达</b>已把反代端点(<code>/v1/*</code>、<code>/origin/revproxy/*</code>)一并暴露公网，故此处<b>不另起</b>第二条隧道。隧道<b>启停</b>请到顶部「🌐 内网穿透」板块；下方状态/公网接入/自测<b>实时映射</b>该共享隧道。<span style="opacity:0.6">道并行而不相悖 · 不重复造轮子。</span>
    </div>` : ''}
    <div style="display:flex;align-items:center;gap:8px;padding:6px 2px;border-bottom:1px solid rgba(128,128,128,0.18);flex-wrap:wrap">
      <span style="font-weight:600;font-size:12px">☯ 内网穿透 · DAO Bridge</span>
      <span id="brgStat" style="font-size:10px;opacity:0.65;margin-left:auto">加载中…</span>
    </div>

    <div style="font-size:11px;line-height:1.6;padding:6px 2px;opacity:0.85">
      把「④ 模型反代」的本地端点经 <b>cloudflared 快速隧道</b>(零账号·去中心化)暴露到<b>公网</b>，
      任意常用 AI 工具在公网环境把 Base URL 换成下方<b>公网URL</b>、Header 仍带同一 API Key，
      即可直调反带出来的免费/付费模型。<b>插件激活即自动连接</b>(零配置·断线自愈)；
      手动「停止」后自动连接挂起，点「启动/重启」即恢复常驻。
      <b>v9.9.348</b>: 指数退避(限流不盲冲)·45s宽限(注册中不误杀)·25s冷却(防密集重启)。<span style="opacity:0.6">反者道之动 · 损之又损以至于无为。</span>
    </div>

    <!-- 隧道状态 + 启停 -->
    <div style="border:1px solid rgba(128,128,128,0.22);border-radius:6px;padding:8px;margin:4px 2px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:11px">隧道状态</span>
        <span id="brgState" style="font-size:11px;color:var(--vscode-descriptionForeground,#999)">未连接</span>
        <span id="brgMode" style="font-size:10px;opacity:0.6"></span>
        <span style="margin-left:auto"></span>
        ${foldBridge ? `<span style="font-size:10px;opacity:0.6">启停在顶部「🌐 内网穿透」板块</span>
        <button class="btn" id="brgRefreshBtn" title="刷新共享隧道状态">↻ 刷新</button>` : `<button class="btn add" id="brgStart" title="启动快速隧道(零账号) · 把反代端点暴露公网">▶ 启动隧道</button>
        <button class="btn" id="brgRestart" title="重启隧道(换新公网URL)">↻ 重启</button>
        <button class="btn" id="brgStop" title="停止隧道 · 关闭公网暴露">■ 停止</button>`}
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px">
        <span style="font-weight:600;font-size:11px">公网 URL</span>
        <code id="brgUrl" style="font-size:11px;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));padding:2px 6px;border-radius:3px;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</code>
        <button class="btn" id="brgCopyUrl" title="复制公网 URL">复制</button>
        <button class="btn" id="brgOpenConsole" title="在浏览器打开公网网页对话台(零鉴权直开)">🌐 网页对话台</button>
      </div>
      <div style="font-size:10px;opacity:0.6;margin-top:4px" id="brgBound">本地反代端口: —</div>
    </div>

    <!-- 公网接入信息 (任意 AI 工具直调) -->
    <div style="border:1px solid rgba(128,128,128,0.22);border-radius:6px;padding:8px;margin:4px 2px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:11px">公网接入 (Chat / Responses / Anthropic / Gemini)</span>
        <button class="btn" id="brgCopyInfo" style="margin-left:auto" title="一键复制 公网Base + API Key + 调用示例 整段接入信息">📋 复制接入信息</button>
      </div>
      <div style="font-size:10px;line-height:1.7;margin-top:6px;opacity:0.9">
        <div>Base URL: <code id="brgPubBase" style="background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));padding:1px 5px;border-radius:3px">—</code></div>
        <div>对话补全: <code id="brgPubChat" style="background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));padding:1px 5px;border-radius:3px">—</code></div>
        <div>Responses: <code id="brgPubResponses" style="background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));padding:1px 5px;border-radius:3px">—</code></div>
        <div>Claude 端点: <code id="brgPubMsg" style="background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));padding:1px 5px;border-radius:3px">—</code></div>
        <div>Gemini 端点: <code id="brgPubGemini" style="background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));padding:1px 5px;border-radius:3px">—</code></div>
        <div>模型列表: <code id="brgPubModels" style="background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));padding:1px 5px;border-radius:3px">—</code></div>
        <div>API Key: <code id="brgPubKey" style="background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));padding:1px 5px;border-radius:3px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom">—</code></div>
      </div>
      <div style="font-size:10px;opacity:0.55;margin-top:6px">Header: <code>Authorization: Bearer {API Key}</code> · model 可填 modelUid 或家族别名(如 glm-4.7)。公网访问需已设 API Key(启动隧道时自动确保)。</div>
    </div>

    <!-- 公网连通自测 (经公网URL发一次真请求) -->
    <div style="border:1px solid rgba(128,128,128,0.22);border-radius:6px;padding:8px;margin:4px 2px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:11px">公网连通自测</span>
        <input id="brgTestPrompt" placeholder="测试提示词 (默认: 你好)" style="flex:1;min-width:120px;font-size:11px;padding:2px 6px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.2));color:var(--vscode-input-foreground,var(--vscode-foreground))">
        <button class="btn" id="brgHealth" title="经公网URL GET /v1/models · 验证隧道可达">health</button>
        <button class="btn add" id="brgTestRun" title="经公网URL发一次标准 OpenAI 请求 · 验证公网全链路直调反带模型">▶ 公网直调测试</button>
      </div>
      <pre id="brgTestOut" style="display:none;max-height:200px;overflow:auto;margin:6px 0 0;padding:8px;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));border-radius:4px"></pre>
    </div>

    <!-- 固定公网域名 · 只需一个 Cloudflare API Token(零域名) · 折入模式由「🌐 内网穿透」板块统一管理, 此处隐藏 -->
    ${foldBridge ? '' : `<details style="margin:4px 2px;border:1px solid rgba(128,128,128,0.18);border-radius:6px;padding:6px 8px" open>
      <summary style="font-size:11px;font-weight:600;cursor:pointer;opacity:0.85">固定公网域名 · 只需一个 Cloudflare API Token(零域名·永不轮换)</summary>
      <div style="font-size:10px;line-height:1.6;margin-top:6px;opacity:0.8">
        快速隧道每次重启换 URL。想要<b>固定不变</b>的公网地址，<b>不必自备域名</b>——只需在
        <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">Cloudflare 面板</a> 创建一个 API Token
        (权限含 <code>Account · Workers Scripts:Edit</code>)，粘到下面点「绑定并固定」。系统会自动把最小中继 Worker
        部署到<b>你自己</b>的免费 <code>*.workers.dev</code> 子域，得到永久固定的反代公网入口。
        <span style="opacity:0.6">此为可选项，非前置条件；默认仍走零账号快速隧道。</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px">
        <input id="brgCfToken" type="password" placeholder="Cloudflare API Token" style="flex:2;min-width:160px;font-size:11px;padding:2px 6px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.2));color:var(--vscode-input-foreground,var(--vscode-foreground))">
        <button class="btn add" id="brgBindCf" title="用 API Token 自动部署 workers.dev 固定中继(零域名·持久通道)">绑定并固定</button>
        <button class="btn" id="brgLogout" title="解绑并退出：停中继+清除所有 Cloudflare 凭证(即使数据损坏也可清)">✖ 退出/解绑</button>
      </div>
      <div id="brgRelayState" style="font-size:10px;opacity:0.7;margin-top:4px"></div>
      <div id="brgRelayUrl" style="font-size:10px;opacity:0.7;margin-top:2px;word-break:break-all"></div>
      <details style="margin-top:6px">
        <summary style="font-size:10px;cursor:pointer;opacity:0.6">高级 · 命名隧道 Tunnel Token (需自备域名)</summary>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px">
          <input id="brgCfEmail" placeholder="Cloudflare 邮箱 (可选)" style="flex:1;min-width:120px;font-size:11px;padding:2px 6px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.2));color:var(--vscode-input-foreground,var(--vscode-foreground))">
          <input id="brgCfKey" type="password" placeholder="Tunnel Token (eyJ…)" style="flex:1.6;min-width:140px;font-size:11px;padding:2px 6px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.2));color:var(--vscode-input-foreground,var(--vscode-foreground))">
          <button class="btn add" id="brgCfSave" title="保存 Cloudflare 凭证/命名隧道 Token">保存</button>
          <button class="btn" id="brgStartNamed" title="用已保存的命名隧道 Token 启动固定域名隧道">▶ 启动固定隧道</button>
        </div>
      </details>
      <div id="brgCfState" style="font-size:10px;opacity:0.6;margin-top:4px">未登录 Cloudflare (默认走零账号快速隧道)</div>
    </details>`}
  </div>

  <div class="dao-pane" id="paneProtocolBridge">
    <div style="display:flex;align-items:center;gap:6px;padding:6px 2px;border-bottom:1px solid rgba(128,128,128,0.18);flex-wrap:wrap">
      <b>外部模型协议中转站</b>
      <span style="font-size:10px;opacity:0.6">Chat-only 上游 → Responses / Anthropic / Gemini · 保存即同步②渠道与③路由</span>
      <button class="btn" id="pbRefresh" style="margin-left:auto">刷新</button>
    </div>
    <div class="pb-scroll">
      <div class="pb-card">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <b>对外接入信息</b>
          <span id="pbAccessStatus" style="font-size:10px;opacity:0.65">加载中…</span>
          <button class="btn" id="pbAccessRefresh" style="margin-left:auto">刷新</button>
        </div>
        <div class="pb-grid" style="margin-top:6px">
          <div><span class="pb-label">Base URL</span><code id="pbAccessBase" style="word-break:break-all">—</code> <button class="btn" id="pbCopyBase">复制</button></div>
          <div><span class="pb-label">API Key</span><code id="pbAccessKey" style="word-break:break-all">—</code> <button class="btn" id="pbToggleKey">隐藏</button> <button class="btn" id="pbCopyKey">复制</button></div>
        </div>
        <details open style="margin-top:6px">
          <summary style="font-size:10px;cursor:pointer;opacity:0.75">四协议对外接口</summary>
          <div id="pbAccessEndpoints" style="margin-top:4px"></div>
        </details>
      </div>
      <div class="pb-card">
        <div class="pb-grid">
          <label><span class="pb-label">中转名称</span><input id="pbName" placeholder="如 DeepSeek → Responses"></label>
          <label><span class="pb-label">模型来源</span><select id="pbProviderMode"><option value="existing">使用②已有渠道模型</option><option value="custom">使用⑦自定义多渠道模型</option><option value="managed">新建渠道并同步到②</option></select></label>
          <label id="pbExistingWrap"><span class="pb-label">已有渠道</span><select id="pbProvider"></select></label>
          <label id="pbCustomWrap" style="display:none"><span class="pb-label">自定义模型</span><select id="pbCustomModel"></select><span class="cm-hint">引用⑦的完整渠道优先级、协议和思考强度；后续修改自动生效</span></label>
          <label id="pbManagedNameWrap" style="display:none"><span class="pb-label">新渠道名称</span><input id="pbManagedName" placeholder="如 deepseek-relay"></label>
          <label id="pbBaseUrlWrap" style="display:none"><span class="pb-label">上游 Base URL</span><input id="pbBaseUrl" placeholder="https://api.deepseek.com"></label>
          <label id="pbApiKeyWrap" style="display:none"><span class="pb-label">上游 API Key</span><input id="pbApiKey" type="password" placeholder="编辑时留空=保留"></label>
          <label><span class="pb-label">上游真实协议 · 按渠道能力</span><select id="pbSourceProtocol"></select></label>
          <label><span class="pb-label">上游真实模型 · 自动探测</span><select id="pbSourceModel"></select><input id="pbSourceModelCustom" placeholder="手动输入模型名" style="display:none;margin-top:4px"></label>
          <label><span class="pb-label">对外模型别名</span><input id="pbOutputModel" placeholder="deepseek-responses"></label>
          <label><span class="pb-label">最大输出 Token</span><input id="pbMaxTokens" type="number" value="16384"></label>
          <label><span class="pb-label">默认思考强度 · 自动探取</span><select id="pbReasoning"><option value="off">关闭</option></select><span id="pbCapability" style="display:block;font-size:9px;opacity:0.6;margin-top:3px">选择渠道与模型后自动探取</span></label>
        </div>
        <div style="margin-top:7px;font-size:10px">
          <span style="opacity:0.65;margin-right:5px">转换后允许调用协议:</span>
          <label style="margin-right:8px"><input class="pb-target" type="checkbox" value="openai-chat"> Chat</label>
          <label style="margin-right:8px"><input class="pb-target" type="checkbox" value="openai-responses" checked> Responses</label>
          <label style="margin-right:8px"><input class="pb-target" type="checkbox" value="anthropic"> Anthropic</label>
          <label><input class="pb-target" type="checkbox" value="gemini"> Gemini</label>
        </div>
        <div style="display:flex;gap:5px;align-items:center;margin-top:8px;flex-wrap:wrap">
          <button class="btn add" id="pbSave">保存并同步</button>
          <button class="btn" id="pbReset">新建</button>
          <button class="btn probe" id="pbDetect">重新探测渠道协议与模型</button>
          <span id="pbDetectStatus" style="font-size:10px;opacity:0.65"></span>
          <span id="pbStatus" style="font-size:10px;opacity:0.7"></span>
        </div>
      </div>
      <div class="pb-card">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <b>协议转换全链路测试</b>
          <span style="font-size:10px;opacity:0.6">真实请求 · 验证上游协议 → 对外协议转换结果</span>
        </div>
        <div class="pb-grid" style="margin-top:6px">
          <label><span class="pb-label">中转档案</span><select id="pbTestProfile"></select></label>
          <label><span class="pb-label">目标协议</span><select id="pbTestProtocol"></select></label>
          <label style="grid-column:span 2"><span class="pb-label">测试提示词</span><input id="pbTestPrompt" value="只回复 PROXY_OK"></label>
        </div>
        <div style="display:flex;gap:5px;align-items:center;margin-top:7px;flex-wrap:wrap">
          <button class="btn add" id="pbTestRun">▶ 测试所选协议</button>
          <button class="btn probe" id="pbTestAll">▶ 测试档案全部协议</button>
          <span id="pbTestStatus" style="font-size:10px;opacity:0.7"></span>
        </div>
        <pre id="pbTestOutput" style="display:none;max-height:240px;overflow:auto;margin:7px 0 0;padding:7px;font-size:10px;white-space:pre-wrap;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));border-radius:4px"></pre>
      </div>
      <details class="pb-card">
        <summary style="cursor:pointer"><b>Codex / Claude Code / OpenCode / MiMoCode / OpenClaw / Hermes 配置</b></summary>
        <div class="pb-grid" style="margin-top:7px">
          <label><span class="pb-label">使用中转档案</span><select id="pbClientProfile"></select></label>
          <label><span class="pb-label">客户端</span><select id="pbClient"><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="opencode">OpenCode</option><option value="mimocode">MiMoCode</option><option value="openclaw">OpenClaw</option><option value="hermes">Hermes</option></select></label>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap">
          <span id="pbClientStatus" style="font-size:10px;opacity:0.72"></span>
          <button class="btn" id="pbCopyClient" style="margin-left:auto">复制完整配置</button>
        </div>
        <pre id="pbClientConfig" style="max-height:300px;overflow:auto;margin:6px 0 0;padding:7px;font-size:10px;white-space:pre-wrap;background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.18));border-radius:4px"></pre>
      </details>
      <div id="pbList"></div>
    </div>
  </div>

  <div class="dao-pane" id="paneCustomModel">
    <div style="display:flex;align-items:center;gap:6px;padding:6px 2px;border-bottom:1px solid rgba(128,128,128,0.18);flex-wrap:wrap">
      <b>自定义模型</b>
      <span class="cm-hint">选择②已有渠道与真实模型 · 自动同步③④⑥和 Devin 模型目录</span>
      <span id="cmStatus" style="font-size:10px;opacity:0.65">加载中…</span>
      <button class="btn" id="cmRefresh" style="margin-left:auto">刷新</button>
    </div>
    <div class="pb-scroll">
      <div id="cmRuntimeBanner" class="cm-runtime-banner"><span class="cm-runtime-main">当前实际使用：等待首次真实请求</span><span class="cm-hint">页面会自动刷新，无需手动点击刷新</span></div>
      <div class="pb-card">
        <div class="cm-section-title"><b>模型身份与渠道优先队列</b><span class="cm-hint">从上到下依次故障转移；成功渠道保持到失败或优先级改变</span></div>
        <div class="pb-grid">
          <label><span class="pb-label">Devin 模型 UID</span><input id="cmId" placeholder="如 gpt-5-6-sol-custom"></label>
          <label><span class="pb-label">显示名称</span><input id="cmLabel" placeholder="如 GPT-5.6 Sol · 自定义"></label>
          <label><span class="pb-label">待加入渠道</span><select id="cmProvider"></select></label>
          <label><span class="pb-label">该渠道的上游真实模型</span><select id="cmUpstream"></select><input id="cmUpstreamCustom" placeholder="手动输入上游模型名" style="display:none;margin-top:4px"></label>
          <label><span class="pb-label">上游协议</span><select id="cmProtocol"><option value="">跟随渠道</option><option value="openai-chat">OpenAI Chat</option><option value="openai-responses">Responses</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option></select></label>
          <label><span class="pb-label">渠道选择策略</span><select id="cmChannelStrategy"><option value="priority">按优先级故障转移</option><option value="random">随机首选（会话内保持）</option></select></label>
        </div>
        <div class="cm-actions">
          <button class="btn probe" id="cmReloadModels">重新探测渠道模型</button>
          <button class="btn add" id="cmAddChannel">加入优先队列</button>
          <button class="btn" id="cmCancelChannelEdit" style="display:none">取消编辑</button>
          <span id="cmModelStatus" class="cm-hint">使用②渠道已缓存的模型目录</span>
        </div>
        <div id="cmChannelList" class="cm-channel-list"></div>
        <div class="cm-hint" style="margin-top:5px">拖动左侧手柄调整优先级；第一项为首选，后续项为备用。保存后下一次请求立即采用新顺序。</div>
      </div>
      <div class="pb-card">
        <div class="cm-section-title"><b>模型能力与 Devin 行为</b><span class="cm-hint">思考档位由渠道元数据或模型族自动推断</span></div>
        <div class="pb-grid">
          <label><span class="pb-label">思考强度</span><select id="cmReasoning"><option value="off">关闭</option></select></label>
          <label><span class="pb-label">上下文 Token</span><input id="cmContext" type="number" value="131072"></label>
          <label><span class="pb-label">最大输出 Token</span><input id="cmMaxTokens" type="number" value="16384"></label>
          <label><span class="pb-label">多模态能力</span><span style="display:flex;align-items:center;min-height:24px;font-size:10px"><input id="cmImages" type="checkbox" style="width:auto;margin-right:5px">支持图片输入</span></label>
        </div>
        <div id="cmCapability" class="cm-capability">选择渠道与模型后自动探取</div>
        <div class="cm-actions">
          <button class="btn probe" id="cmDetect">探取模型能力</button>
          <span style="margin-left:auto"></span>
          <button class="btn" id="cmReset">新建</button>
          <button class="btn add" id="cmSave">保存并同步②③④⑥</button>
        </div>
      </div>
      <div class="pb-card">
        <div class="cm-section-title"><b>已注册模型</b><span class="cm-hint">编辑或删除前会检查③路由与⑥中转引用</span></div>
        <div id="cmList"></div>
      </div>
    </div>
  </div>

  <!-- 路由编辑弹窗 -->
  <div class="dao-pane" id="paneCodex">
    <div class="codex-head">
      <div>
        <b>Codex 热路由</b>
        <div class="cm-hint">保留 Codex 当前 Provider、模型和全部其他配置，只将当前 Provider 的 Base URL 与令牌接入热路由；之后可在②或本页切换渠道，无需重启。</div>
      </div>
      <button class="btn" id="codexRefresh" type="button">刷新状态</button>
    </div>
    <div class="codex-layout">
      <section class="codex-section">
        <div class="cm-section-title"><b>当前连接</b><span id="codexStatus" class="cm-hint">加载中...</span></div>
        <div id="codexRuntime" class="codex-runtime">尚未接管 Codex</div>
        <dl class="codex-endpoints">
          <div><dt>稳定 Base URL</dt><dd><code id="codexBaseUrl">-</code></dd></div>
          <div><dt>Responses 端点</dt><dd><code id="codexEndpoint">-</code></dd></div>
          <div><dt>Codex 模型（保留）</dt><dd><code id="codexLocalModel">-</code></dd></div>
        </dl>
        <div class="codex-observed-title">Codex 实际配置（自动同步）</div>
        <dl class="codex-endpoints">
          <div><dt>实际 Provider</dt><dd><code id="codexObservedProvider">-</code></dd></div>
          <div><dt>实际模型</dt><dd><code id="codexObservedModel">-</code></dd></div>
          <div><dt>实际推理强度</dt><dd><code id="codexObservedReasoning">-</code></dd></div>
          <div><dt>实际协议 / 地址</dt><dd><code id="codexObservedEndpoint">-</code></dd></div>
        </dl>
        <div id="codexPreservation" class="codex-preservation">账号登录与历史会话：未触碰</div>
      </section>
      <section class="codex-section">
        <div class="cm-section-title"><b>路由选择</b><span class="cm-hint">渠道来自②渠道配置</span></div>
        <div class="pb-grid codex-grid">
          <label><span class="pb-label">渠道</span><select id="codexProvider"></select></label>
          <label><span class="pb-label">真实模型</span><select id="codexModel"></select></label>
          <label><span class="pb-label">上游协议</span><select id="codexProtocol"><option value="">跟随渠道</option><option value="openai-responses">OpenAI Responses</option><option value="openai-chat">OpenAI Chat</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option></select></label>
          <label><span class="pb-label">思考强度</span><select id="codexReasoning"><option value="off">关闭</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option></select></label>
        </div>
        <div class="codex-actions">
          <span id="codexHint" class="cm-hint">首次应用会安全备份并更新 ~/.codex/config.toml。</span>
          <button class="btn add" id="codexApply" type="button">应用并接管 Codex</button>
        </div>
      </section>
      <section class="codex-section codex-change-section">
        <div class="cm-section-title">
          <b>Codex 文件变更</b>
          <span id="codexChangesPhase" class="cm-hint">未捕获</span>
        </div>
        <div class="codex-change-toolbar">
          <button class="btn add" id="codexChangesStart" type="button">继续捕获</button>
          <button class="btn" id="codexChangesStop" type="button" disabled>停止捕获</button>
          <button class="btn" id="codexChangesReset" type="button">重建基线</button>
          <span id="codexChangesSummary" class="codex-change-summary">0 个文件</span>
          <button class="btn" id="codexChangesAcceptAll" type="button" disabled>全部接受</button>
          <button class="btn del" id="codexChangesRejectAll" type="button" disabled>全部回退</button>
        </div>
        <div id="codexChangesRoots" class="codex-change-roots">当前没有文件工作区</div>
        <div id="codexChangesNotice" class="codex-change-notice">工作区打开后自动建立基线并捕获内部、外部文件变更。</div>
        <div id="codexChangesList" class="codex-change-list">
          <div class="codex-change-empty">暂无捕获到的文件变更</div>
        </div>
      </section>
    </div>
  </div>

  <!-- ⑨ 观测台 · 告警/链路回放/失败模式/审计/配置历史 -->
  <div class="dao-pane" id="paneObs">
    <div style="display:flex;align-items:center;gap:6px;padding:4px 2px">
      <b>观测台</b>
      <span class="cm-hint">告警 · 链路回放 · 失败模式 · 审计 · 配置历史</span>
      <button class="btn" id="obsRefresh" type="button" style="margin-left:auto">刷新</button>
    </div>
    <div class="cm-section-title" style="margin-top:6px"><b>⚙ 全局设置</b><span class="cm-hint">OTEL 链路导出 · Cascade 出站脱敏 · 热生效</span></div>
    <div style="display:flex;flex-direction:column;gap:6px;padding:6px 4px;border:1px solid rgba(128,128,128,0.18);border-radius:5px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <label class="rp-switch" title="把每请求链路(路由→重试→换渠道→降级)导出到 OTLP/HTTP 后端"><input type="checkbox" id="obsOtelEnabled"> OTEL 链路导出</label>
        <span id="obsOtelStat" style="font-size:10px;opacity:0.65">—</span>
      </div>
      <div style="display:flex;gap:5px">
        <input type="text" id="obsOtelEndpoint" placeholder="OTLP 端点 如 http://localhost:4318" style="flex:1;font-size:10px;padding:2px 5px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.2));color:var(--vscode-input-foreground,var(--vscode-foreground))">
        <input type="text" id="obsOtelService" placeholder="service.name" style="width:110px;font-size:10px;padding:2px 5px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-input-background,rgba(0,0,0,0.2));color:var(--vscode-input-foreground,var(--vscode-foreground))">
        <button class="btn" id="obsOtelSave" type="button" style="font-size:10px">保存</button>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid rgba(128,128,128,0.12);padding-top:6px">
        <label class="rp-switch" title="Cascade 出站发往上游前扫高置信度密钥/凭证"><input type="checkbox" id="obsRedactEnabled"> 出站脱敏(Cascade)</label>
        <select id="obsRedactMode" style="font-size:10px;padding:1px 4px;border:1px solid rgba(128,128,128,0.3);border-radius:3px;background:var(--vscode-dropdown-background,rgba(0,0,0,0.2));color:var(--vscode-dropdown-foreground,var(--vscode-foreground))">
          <option value="monitor">监控(只记)</option>
          <option value="redact">脱敏(替换)</option>
          <option value="block">拦截(拒绝)</option>
        </select>
      </div>
    </div>
    <div class="cm-section-title" style="margin-top:10px"><b>🚨 告警</b><span id="obsAlertHint" class="cm-hint"></span></div>
    <div id="obsAlerts" style="max-height:140px;overflow:auto;font-size:11px">加载中...</div>
    <div class="cm-section-title" style="margin-top:10px"><b>📉 失败模式</b><span class="cm-hint">渠道×错误类型 · 含建议</span></div>
    <div id="obsFailures" style="max-height:160px;overflow:auto;font-size:11px">加载中...</div>
    <div class="cm-section-title" style="margin-top:10px"><b>🔍 链路回放</b><span class="cm-hint">每笔请求 路由→重试→换渠道→降级</span></div>
    <div id="obsTraces" style="max-height:220px;overflow:auto;font-size:11px">加载中...</div>
    <div class="cm-section-title" style="margin-top:10px"><b>📝 动作审计</b><span class="cm-hint">谁何时改了什么配置 · apiKey 已脱敏</span></div>
    <div id="obsAudit" style="max-height:140px;overflow:auto;font-size:11px">加载中...</div>
    <div class="cm-section-title" style="margin-top:10px"><b>🗂 配置历史</b><span class="cm-hint">一键回滚 · 回滚前自动再备份</span>
      <button class="btn" id="obsExportPack" type="button" style="margin-left:auto">导出配置包</button>
      <button class="btn" id="obsImportPack" type="button">导入配置包</button>
    </div>
    <div id="obsBackups" style="max-height:140px;overflow:auto;font-size:11px">加载中...</div>
    <textarea id="obsPackBox" style="display:none;width:100%;height:90px;margin-top:4px;font-size:10px" placeholder="粘贴配置包 JSON 后再点一次「导入配置包」"></textarea>
  </div>

  <div class="route-modal" id="routeModal">
    <div class="route-modal-inner">
      <h4 id="routeModalTitle">添加路由</h4>
      <div>
        <label style="font-size:10px;opacity:0.6">官方模型 UID</label>
        <input id="routeModelUid" placeholder="如 MODEL_SWE_1_6_FAST">
      </div>
      <div>
        <label style="font-size:10px;opacity:0.6">Provider</label>
        <select id="routeProvider"></select>
      </div>
      <div>
        <label style="font-size:10px;opacity:0.6">外接模型</label>
        <select id="routeExtModel"><option value="">请先选择 Provider</option></select>
      </div>
      <div>
        <label style="font-size:10px;opacity:0.6">最大输出 Token (max_tokens · 单次回复上限 · 越大越费)</label>
        <input id="routeMaxTokens" type="number" value="16384" placeholder="16384">
      </div>
      <div>
        <label style="font-size:10px;opacity:0.6">采样温度 Temperature (0~2 · 留空=用模型默认)</label>
        <input id="routeTemp" type="number" step="0.1" min="0" max="2" placeholder="留空=默认">
      </div>
      <div>
        <label style="font-size:10px;opacity:0.6">思考强度 · 按模型能力自动提供</label>
        <select id="routeReasoning"><option value="off">关闭</option></select>
        <div id="routeCapability" style="font-size:9px;opacity:0.55;margin-top:3px">选择 Provider 与模型后自动探取</div>
      </div>
      <div class="route-channel-section">
        <div id="routeSharedModelNotice" class="route-shared-notice" style="display:none">
          <span id="routeSharedModelText"></span>
          <button class="btn" id="routeDetachShared" type="button" title="保留当前渠道为独立路由，之后不再同步到⑦">改为独立路由</button>
        </div>
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:5px 0">
          <b style="font-size:10px">渠道优先队列</b>
          <span style="font-size:9px;opacity:0.55">第一项为主渠道 · 仅在已添加渠道内自动切换</span>
          <select id="routeChannelStrategy" title="随机模式只随机选择会话的首选渠道，后续工具回合保持同一渠道" style="width:auto;min-width:150px"><option value="priority">按优先级故障转移</option><option value="random">随机首选（会话内保持）</option></select>
          <span style="flex:1"></span>
          <button class="btn" id="routeNewChannel" type="button">新增备用</button>
          <button class="btn add" id="routeApplyChannel" type="button">加入队列</button>
        </div>
        <div id="routeChannelList" class="route-channel-list"></div>
      </div>
      <div class="route-modal-actions">
        <button class="btn del" id="routeDelete" style="display:none">删除路由</button>
        <span style="flex:1"></span>
        <button class="btn add" id="routeSave">保存</button>
        <button class="btn" id="routeCancel">取消</button>
      </div>
    </div>
  </div>

  <!-- 状态栏 -->
  <div class="status-bar" id="statusBar">
    <span id="statusText">加载中...</span>
  </div>

<script nonce="${N}">${_desktopBridgeScript(opts && opts.desktop)}${clientScript}</script>
</body>
</html>`;
}

// 已通过语法预检的脚本内容指纹 · 跳过对同一版本 ~200KB 客户端脚本的重复
//   vm.Script 编译 (每次开面板都编译整包是可感知的打开延迟)。
const _checkedScriptHashes = new Set();
function _fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function getCheckedEaConfigHtml(port, nonce, opts, onError) {
  const html = getEaConfigHtml(port, nonce, opts);
  try {
    const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let scriptCount = 0;
    let match;
    while ((match = scriptPattern.exec(html))) {
      scriptCount += 1;
      const src = match[1];
      const key = src.length + ":" + _fnv1a(src);
      if (_checkedScriptHashes.has(key)) continue; // 同一脚本已校验过 · 免重复编译
      new vm.Script(src, { filename: `dao-flow-webview-${scriptCount}.js` });
      _checkedScriptHashes.add(key);
    }
    if (!scriptCount) throw new Error("未找到 Webview 脚本");
    return html;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (typeof onError === "function") onError(`Webview 脚本预检失败: ${message}`);
    return `<!DOCTYPE html><html lang="zh-CN"><meta charset="UTF-8"><body style="padding:16px;font-family:sans-serif;color:#e6e6e6;background:#1e1e1e"><h3>插件面板加载失败</h3><p>Webview 脚本语法预检未通过，请重新安装最新版本。</p><pre style="white-space:pre-wrap;color:#f48771">${_escapeHtml(message)}</pre></body></html>`;
  }
}

module.exports = { getEaConfigHtml, getCheckedEaConfigHtml };

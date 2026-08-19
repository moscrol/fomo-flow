"use strict";
/**
 * dao_router.js · 道路由 v2.0 · 透明模型替换 · 反者道之动
 * ════════════════════════════════════════════════════════════════
 *
 *   《帛书·四十章》: "反也者，道之动也；弱也者，道之用也"
 *   《阴符经》: "天之至私，用之至公 · 禽之制在炁"
 *
 *   本源架构 v2.0:
 *     小模型 → cascadeRelay(道直连器:7861) → Cascade官方云端(账号池)
 *     fallback → github备用(Azure/GitHub Models)
 *     大模型(Claude4.6/4.7/GPT-5) → 不路由 → 直接透传官方
 *
 *   多提供商支持:
 *     cascadeRelay: noProviderPrefix=true → 直接调 http://127.0.0.1:7861/v1/chat/completions
 *     github: noProviderPrefix=true → 直接调 https://models.inference.ai.azure.com/chat/completions
 *     其他: gateway::model 格式 → 070网关 → 对应provider
 *
 *   内建退化:
 *     target.fallback → { provider, model } 主路由失败时自动尝试
 *     若两者均失败 → return false → MITM回落官方上游
 *
 *   配置 (配置.json):
 *     daoRoutes.routes["MODEL_UID"] = {
 *       provider, model, fallback: { provider, model },
 *       maxOutputTokens, _label
 *     }
 *     providers["providerName"] = {
 *       baseUrl, noProviderPrefix, completionPath, apiKey, enabled
 *     }
 */

const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const crypto = require("crypto");
const os = require("os");
const { execFileSync } = require("child_process");
const { createCustomModelRegistry } = require("./custom_model_registry");

function _resolveKeychainApiKey(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^keychain:([A-Za-z0-9._-]{1,128})$/);
  if (!match || process.platform !== "darwin") return raw;
  try {
    return execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        match[1],
        "-a",
        os.userInfo().username,
        "-w",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "";
  }
}
const _localWorkspaceTools = require("./local_workspace_tools");
const _EXPOSE_REASONING = process.env.DAO_EXPOSE_REASONING === "1";

// ★ v9.9.102 → 修法㉑+ · 上游代理agent (自包含 · 无需 https-proxy-agent 依赖) · 道法自然
//   根因①: 远程机直连境外 provider 被网络阻断 → connect ETIMEDOUT / TLS 握手失败
//   根因②: 旧实现 require('https-proxy-agent') 在打包环境 MODULE_NOT_FOUND → 静默失败 → 代理形同虚设
//   修复: 纯 Node net+tls 实现 HTTP CONNECT 隧道 Agent · 无外部依赖
//         代理URL来源: 环境变量 HTTPS_PROXY/HTTP_PROXY → Windows 系统代理(WinINET) · 不硬编码任何端口
//   道义: 四十章「弱也者 道之用也」· 代理即弱用 · 不直连而通天下 · 不假外求(无外部依赖)
const net = require("net");
const tls = require("tls");

let _proxyUrlResolved; // undefined=未解析, null=无代理, string=代理URL
function _resolveProxyUrl() {
  if (_proxyUrlResolved !== undefined) return _proxyUrlResolved;
  // 1) 环境变量 (优先)
  let url =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null;
  // 2) Windows 系统代理 (WinINET) · 兑现"运行时检测系统代理"承诺 · 不硬编码
  if (!url && process.platform === "win32") {
    try {
      const root =
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
      const q = (name) =>
        require("child_process").execSync(`reg query "${root}" /v ${name}`, {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
      const em = q("ProxyEnable").match(
        /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/,
      );
      if (em && parseInt(em[1], 16) === 1) {
        const pm = q("ProxyServer").match(/ProxyServer\s+REG_SZ\s+(\S+)/);
        if (pm) {
          let p = pm[1].trim();
          if (p.indexOf("=") !== -1) {
            const mm = p.match(/https=([^;]+)/) || p.match(/http=([^;]+)/);
            p = mm ? mm[1].trim() : p.split(";")[0].trim();
          }
          if (p && !/^https?:\/\//i.test(p)) p = "http://" + p;
          url = p || null;
        }
      }
    } catch (_e) {
      /* 无系统代理 → 直连 */
    }
  }
  _proxyUrlResolved = url || null;
  return _proxyUrlResolved;
}

function _isLocalHostName(host) {
  if (!host) return false;
  if (host === "localhost" || host === "::1") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

// 纯 Node 实现的 HTTP CONNECT 隧道 https Agent · 无外部依赖
class _DaoTunnelAgent extends https.Agent {
  constructor(proxyUrl, opts) {
    super(opts || {});
    const u = new URL(proxyUrl);
    this._proxyHost = u.hostname;
    this._proxyPort = parseInt(u.port || "80", 10);
  }
  createConnection(options, cb) {
    const destHost = options.host || options.hostname;
    const destPort = parseInt(options.port || 443, 10);
    // 本地/内网目标 → 不走代理 (直接 TLS)
    if (_isLocalHostName(destHost)) {
      return super.createConnection(options, cb);
    }
    const sock = net.connect(this._proxyPort, this._proxyHost);
    let settled = false;
    let buf = "";
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch (_) {}
      cb(e);
    };
    sock.once("error", fail);
    sock.setTimeout(20000, () => fail(new Error("dao proxy tunnel timeout")));
    sock.on("connect", () => {
      sock.write(
        `CONNECT ${destHost}:${destPort} HTTP/1.1\r\nHost: ${destHost}:${destPort}\r\n\r\n`,
      );
    });
    const onData = (chunk) => {
      buf += chunk.toString("binary");
      if (buf.indexOf("\r\n\r\n") === -1) return;
      sock.removeListener("data", onData);
      const statusLine = buf.split("\r\n")[0];
      if (!/ 200 /.test(statusLine)) {
        fail(new Error("dao proxy CONNECT rejected: " + statusLine));
        return;
      }
      sock.setTimeout(0);
      sock.removeListener("error", fail);
      const tlsSock = tls.connect(
        {
          socket: sock,
          servername: options.servername || destHost,
          rejectUnauthorized: _tlsRejectUnauthorized(options.rejectUnauthorized),
        },
        () => {
          if (!settled) {
            settled = true;
            cb(null, tlsSock);
          }
        },
      );
      tlsSock.once("error", (e) => {
        if (!settled) {
          settled = true;
          cb(e);
        }
      });
    };
    sock.on("data", onData);
    return undefined; // 异步经 cb 返回
  }
}

let _daoTunnelAgent = null;
let _daoTunnelAgentUrl = null;
const _affinityAgents = new Map();
const _AFFINITY_AGENT_LIMIT = 64;

function _touchAffinityAgent(key, agent) {
  _affinityAgents.delete(key);
  _affinityAgents.set(key, agent);
  while (_affinityAgents.size > _AFFINITY_AGENT_LIMIT) {
    const oldestKey = _affinityAgents.keys().next().value;
    const oldest = _affinityAgents.get(oldestKey);
    _affinityAgents.delete(oldestKey);
    try {
      oldest.destroy();
    } catch {}
  }
  return agent;
}

function _getAffinityAgent(isHttps, targetUrl, providerName, promptCacheKey) {
  const proxyAgent = _getProxyAgent(isHttps);
  if (proxyAgent) return proxyAgent;
  const origin = targetUrl && targetUrl.origin ? targetUrl.origin : "unknown";
  const affinity = promptCacheKey
    ? _cacheFingerprint(promptCacheKey)
    : "shared";
  const key = `${isHttps ? "https" : "http"}|${origin}|${providerName || ""}|${affinity}`;
  const existing = _affinityAgents.get(key);
  if (existing) return _touchAffinityAgent(key, existing);
  const Agent = isHttps ? https.Agent : http.Agent;
  const agent = new Agent({
    keepAlive: true,
    keepAliveMsecs: 45000,
    maxSockets: promptCacheKey ? 1 : 4,
    maxFreeSockets: promptCacheKey ? 1 : 2,
    scheduling: "fifo",
  });
  return _touchAffinityAgent(key, agent);
}

/**
 * ★ 获取代理agent · 运行时动态检测 (环境变量 + Windows系统代理) · 自包含无依赖
 *   道义: 四十一章「大白如辱」· 代理存在但不可见
 */
function _getProxyAgent(isHttps) {
  // 仅对 https 上游启用隧道 (http/本地上游保持直连原状)
  if (!isHttps) return undefined;
  const url = _resolveProxyUrl();
  if (!url) return undefined;
  if (_daoTunnelAgent && _daoTunnelAgentUrl === url) return _daoTunnelAgent;
  try {
    _daoTunnelAgent = new _DaoTunnelAgent(url, {
      keepAlive: true,
      keepAliveMsecs: 45000,
      maxSockets: 4,
      maxFreeSockets: 2,
      scheduling: "fifo",
    });
    _daoTunnelAgentUrl = url;
    return _daoTunnelAgent;
  } catch (_e) {
    return undefined;
  }
}

// ★ v9.9.92 · 修法⑦ · 引用 sp_invert.js · 仅用于 SP 检测+日志 · 不修改 SP
//   道义: 最上游 · source.js 已改 SP → 此处仅检测一致性 · 不补丁式修改
//   二十八章「圣人执一以为天下牧」· SP 修改归一引擎 · 路由器只观不造
let _spInvert = null;
try {
  _spInvert = require(path.join(__dirname, "sp_invert"));
} catch {}

// ★ Windows Agent 原生工具层 · windows-agent 经藏启用时注入+代理执行
//   与官方服务端工具同格 · LSP 太上不知有之 · 非 MCP 层
let _winTools = null;
try {
  _winTools = require(path.join(__dirname, "windows_tools"));
} catch {}

function _isWinTool(name) {
  return !!(_winTools && _winTools.enabled() && _winTools.has(name));
}

// 代理侧拦截判定归一: 仅代理工具 ∪ Windows 原生工具(启用时)
function _isLocalWorkspaceTool(name, argsJson) {
  try {
    return _localWorkspaceTools.canHandle(name, argsJson);
  } catch (_) {
    return false;
  }
}

const _grepOnlyLocalWorkspaceToolNames = new Set([
  "grep_search",
  "Grep",
  "GrepSearch",
]);

function _shouldInterceptLocalWorkspaceTool(
  name,
  argsJson,
  localFallbackActive,
  workspaceRoots,
) {
  if (!localFallbackActive) return false;
  if (localFallbackActive === "grep-only") {
    if (!_grepOnlyLocalWorkspaceToolNames.has(String(name || ""))) return false;
    return _localWorkspaceTools.canHandleWithinRoots(
      name,
      argsJson,
      workspaceRoots,
    );
  }
  return _isLocalWorkspaceTool(name, argsJson);
}

function _hasOfficialEmptyWorkspaceMetadata(systemText) {
  return /(?:^|\n)\s*The USER does not have any active workspace\.\s*(?:\n|$)/i.test(
    String(systemText || ""),
  );
}

function _requestWorkspaceRoots(systemText, env = process.env) {
  const candidates = _localWorkspaceTools
    .workspaceRootsFromText(systemText)
    .concat(_localWorkspaceTools.workspaceRoots(env));
  const roots = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key =
      process.platform === "win32"
        ? String(candidate).toLowerCase()
        : String(candidate);
    if (!candidate || seen.has(key)) continue;
    seen.add(key);
    roots.push(candidate);
  }
  return roots;
}

function _localWorkspaceFallbackMode(
  systemText,
  workspaceRoots,
  workspaceToolStats,
) {
  if (workspaceToolStats && workspaceToolStats.degraded) return true;
  // Cortex Grep owns a separate workspace registry and may report it empty only
  // after execution. A validated request root is therefore the reliable signal.
  if (Array.isArray(workspaceRoots) && workspaceRoots.length > 0)
    return "grep-only";
  return false;
}

function _normalizeWorkspaceToolCall(name, argsJson, workspaceContext) {
  try {
    const result = _localWorkspaceTools.normalizeToolCall(name, argsJson, {
      messages: workspaceContext && workspaceContext.messages,
      workspaceRoots: workspaceContext && workspaceContext._workspaceRoots,
      env: (workspaceContext && workspaceContext.env) || {},
    });
    if (result && result.changed) {
      _routeDiag(
        `_workspacePath: ${name} ${result.from} → ${result.to} (${result.reason})`,
      );
      return result.argumentsJson;
    }
    if (result && result.from && result.reason !== "valid-absolute") {
      const roots = Array.isArray(result.roots) ? result.roots.join(" | ") : "";
      _routeDiag(
        `_workspacePath: ${name} unchanged field=${result.field || "?"} path=${result.from} reason=${result.reason || "unknown"} roots=${roots || "none"}`,
      );
    }
  } catch (error) {
    _routeDiag(`_workspacePath: ${name} normalize failed: ${error.message}`);
  }
  return argsJson || "{}";
}

function _isProxyExecTool(name, argsJson) {
  return _proxyOnlyToolNames.has(name) || _isWinTool(name);
}

function _missingRequiredToolArgs(toolCall, lspToolNames) {
  if (!toolCall || !lspToolNames || !lspToolNames.requiredArgs) return [];
  if (
    !/^(?:Edit|edit|edit_file|multi_edit|Write|write_to_file|apply_patch)$/i.test(
      toolCall.name || "",
    )
  )
    return [];
  const required = lspToolNames.requiredArgs.get(toolCall.name) || [];
  if (!required.length) return [];
  let args;
  try {
    args = JSON.parse(toolCall.argumentsJson || "{}");
  } catch {
    return [...required];
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    return [...required];
  return required.filter((name) => {
    if (!Object.prototype.hasOwnProperty.call(args, name)) return true;
    const value = args[name];
    if (value === null || value === undefined) return true;
    if (typeof value === "string" && !value.trim()) return true;
    if (Array.isArray(value) && value.length === 0) return true;
    return false;
  });
}

// ★ v9.9.101 · 太上下知有之 · 增强模式幂等标记 + DAO经藏文本
//   道义: 十七章「太上 下知有之」· DAO存在但不可见 · 官方功能完整保留
const _ENHANCE_MARKER = "\n\n<!-- DAO-ENHANCE v9.9.101 -->\n\n";

// ★ v9.9.288 · 道恒无名 · 去官名归一引擎 (模块级·工具描述+参数描述+SP 共用)
//   v9.9.287 仅覆盖工具顶层 description · 真实流量实测仍漏:
//   ① run_command 等工具的【参数描述】内嵌 "Cascade" (如 Blocking 字段述及)
//   ② 系统提示尾部 "CascadeProjects" (默认工作目录·复合词\bCascade\b 不匹配)
//   道义: 三十二章「道恒无名」· 名去则惑除 · 不改工具名/参数键·仅中性化描述文本。
function _deOfficialName(s) {
  if (typeof s !== "string") return s;
  // v9.9.299 · 单一真源 · 复用 sp_invert.deOfficialName(含主谓一致+句首大写+品牌隔离) · 两路同源
  if (_spInvert && typeof _spInvert.deOfficialName === "function") {
    return _spInvert.deOfficialName(s);
  }
  // 回退(require 失败时)· 与 sp_invert 同源最小逻辑
  return s
    .replace(/CascadeProjects/g, "Projects")
    .replace(/\bthe Cascade\b/g, "the")
    .replace(/\bthe Windsurf\b/g, "the")
    .replace(/\bthe Codeium\b/g, "the")
    .replace(/\bCascade\b/g, "you")
    .replace(/\bWindsurf\b/g, "the editor")
    .replace(/\bCodeium\b/g, "the editor");
}
// 递归中性化对象内所有 description 字段 (含任意层级参数属性描述) · 不动 name/enum/type
function _deOfficialDescDeep(obj) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const it of obj) _deOfficialDescDeep(it);
    return;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k === "description" && typeof v === "string")
      obj[k] = _deOfficialName(v);
    else if (v && typeof v === "object") _deOfficialDescDeep(v);
  }
}
function _getDaoEnhanceText() {
  try {
    if (!_spInvert) return null;
    // ★ 经藏热切真生效 · 以持久化 _origin_canon.txt 为准 · 不滞启动值
    if (typeof _spInvert.hotReloadCanon === "function") {
      try {
        _spInvert.hotReloadCanon();
      } catch {}
    }
    // 从 sp_invert.js 获取经藏文本
    const canonText = _spInvert.getActiveCanonText
      ? _spInvert.getActiveCanonText()
      : null;
    if (!canonText) return null;
    const canonHeader = _spInvert.getCanonHeader
      ? _spInvert.getCanonHeader()
      : "";
    // ★ 工具轴正交叠加 · 工具模式契约(windows/freecad/kicad)与经藏并行注入
    const toolSuffix =
      typeof _spInvert.getToolContractSuffix === "function"
        ? _spInvert.getToolContractSuffix()
        : "";
    return canonHeader + canonText + toolSuffix;
  } catch {
    return null;
  }
}

// ── 状态 ──────────────────────────────────────────────────────
let _cfg = null;
let _loadedConfigFingerprint = "";
let _routes = {}; // modelUid → { provider, model, fallback?, maxOutputTokens }
let _providers = {}; // providerName → { baseUrl, noProviderPrefix, completionPath, apiKey, enabled }
let _customModels = {};
const _customModelRuntime = new Map();
const _routeRuntime = new Map();
let _gatewayUrl = "";
let _log = () => {};
let _ready = false;
function _daoRoutesEnabled() {
  return !(_cfg && _cfg.daoRoutes && _cfg.daoRoutes.enabled === false);
}
function _syncReadyFromRoutes() {
  _ready = _daoRoutesEnabled() && Object.keys(_routes).length > 0;
}
function _isStickySource(source) {
  return source === "sticky" || source === "sticky-circuit";
}
function _tlsRejectUnauthorized(explicit) {
  if (explicit !== undefined) return !!explicit;
  return process.env.DAO_TLS_INSECURE !== "1";
}

// ★ v9.9.99 · 移植 Go EXE 核心模块 · 道法自然 · 取之尽锱铢 用之如泥沙
//   budget:     token 预算管理 (移植自 Go internal/budget)
//   adapters:   多协议适配器 (移植自 Go internal/upstream)
//   resilience: 弹性重试模块 (移植自 Go internal/resilience)
let _budget = null;
let _adapters = null;
let _resilience = null;
let _modelCapabilities = null;
let _contextStrategy = null;
let _toolStrategy = null;
let _toolOutputStore = null;
let _workspaceToolStrategy = null;
let _promptCachePolicyFactory = null;
let _promptCachePolicy = null;
let _promptCachePolicyModule = null;
// ★ 可观测三件套: 链路追踪 / 告警中心 / 配置历史
//   trace_center:   每笔请求的 路由→重试→换渠道→降级 完整轨迹回放
//   alert_center:   预算超限/渠道熔断/全路由失败 主动告警
//   config_history: 配置历史列表/一键回滚/配置包导出导入
let _traceCenter = null;
let _alertCenter = null;
let _configHistory = null;
// ★ 故障自愈与审计:
//   failure_stats: 渠道×错误类型聚合 · 哪个渠道老是什么错
//   action_audit:  配置动作审计 · 谁何时改了什么 · 可追溯可回滚
let _failureStats = null;
let _actionAudit = null;
// ★ OmniRoute 借鉴: 加权评分式自动路由
//   道义: 六十二章「道者萬物之注也」· 善择者得最优
let _channelScorer = null;
let _routingProfiles = null;
let _routePlanner = null;
let _routeDecisionStoreFactory = null;
let _routeDecisionStore = null;
let _routeDecisionStatePath = null;
// ★ 出站脱敏: 发往第三方 provider 前扫高置信度密钥/凭证 (monitor/redact/block)
let _outboundRedact = null;
// ★ 可组合阶段管线 (P/ACP Conductor 骨架 · 步骤1: 出站脱敏作为首个 Stage 试点)
let _pipeline = null;
let _outboundConductor = null;
// ★ OTEL 导出: 把 trace_center 的每请求链路送进 OTLP 后端 (可观测互操作)
let _otelExportFactory = null;
let _otelExporter = null;
let _otelUnsubscribe = null;
try {
  _budget = require(path.join(__dirname, "budget"));
  _adapters = require(path.join(__dirname, "adapters"));
  _resilience = require(path.join(__dirname, "resilience"));
  _modelCapabilities = require(path.join(__dirname, "model_capabilities"));
  _contextStrategy = require(path.join(__dirname, "context_strategy"));
  _toolStrategy = require(path.join(__dirname, "tool_strategy"));
  _toolOutputStore = require(path.join(__dirname, "tool_output_store"));
  _workspaceToolStrategy = require(
    path.join(__dirname, "workspace_tool_strategy"),
  );
  _traceCenter = require(path.join(__dirname, "trace_center"));
  _alertCenter = require(path.join(__dirname, "alert_center"));
  _configHistory = require(path.join(__dirname, "config_history"));
  _failureStats = require(path.join(__dirname, "failure_stats"));
  _actionAudit = require(path.join(__dirname, "action_audit"));
  _channelScorer = require(path.join(__dirname, "channel_scorer"));
  _routingProfiles = require(path.join(__dirname, "routing_profiles"));
  _routePlanner = require(path.join(__dirname, "route_planner"));
  _routeDecisionStoreFactory = require(
    path.join(__dirname, "route_decision_store"),
  );
  _outboundRedact = require(path.join(__dirname, "outbound_redact"));
  _otelExportFactory = require(path.join(__dirname, "otel_export"));
  _pipeline = require(path.join(__dirname, "pipeline"));
} catch (e) {
  // 模块缺失时不阻塞 · 降级为旧逻辑
  _log(`[dao-router] ⚠️ 核心模块加载失败: ${e.message} · 降级为旧逻辑`);
}

try {
  _promptCachePolicyModule = require(path.join(__dirname, "prompt_cache_policy"));
  _promptCachePolicyFactory = _promptCachePolicyModule.createPromptCachePolicy;
} catch (error) {
  _log(`[dao-router] prompt_cache_policy load fail: ${error.message}`);
}

let _agentStatus = null;
try {
  _agentStatus = require(path.join(__dirname, "agent_status"));
} catch (error) {
  _log(`[dao-router] agent_status load fail: ${error.message}`);
}

function _prepareAgentStatus(options) {
  if (!options || !options.key) {
    const messages = options ? options.messages : [];
    return {
      messages:
        _agentStatus && _agentStatus.stripStatusMessages
          ? _agentStatus.stripStatusMessages(messages)
          : messages,
      state: null,
      injected: false,
    };
  }
  if (!_agentStatus)
    return { messages: options.messages, state: null, injected: false };
  return _agentStatus.prepareOutbound(options);
}

function _agentStatusInjectOutbound(target) {
  const routeSetting =
    target && target.agentStatus && typeof target.agentStatus === "object"
      ? target.agentStatus.injectOutbound
      : undefined;
  if (routeSetting !== undefined) return routeSetting !== false;
  const provider = target && target.provider ? _providers[target.provider] : null;
  const providerSetting =
    provider && provider.agentStatus && typeof provider.agentStatus === "object"
      ? provider.agentStatus.injectOutbound
      : undefined;
  return providerSetting !== false;
}

function _recordAgentRoute(callOpts, modelUid, selectedTarget) {
  if (
    !_agentStatus ||
    !callOpts ||
    !callOpts._agentStatusKey ||
    !selectedTarget
  )
    return null;
  return _agentStatus.recordRoute(callOpts._agentStatusKey, {
    modelUid: modelUid || "",
    provider: selectedTarget.provider || "",
    upstreamModel: selectedTarget.model || "",
  });
}

function _finishAgentRequest(key) {
  return _agentStatus && key ? _agentStatus.finishRequest(key) : null;
}

/**
 * 记录模型自报的测试结果 → agent_status.testReport
 *
 * 用 _agentStatusKey（会话状态归属）而不是 _promptCacheKey：后者是缓存分片
 * 维度，可能因模型/协议切换而变，用它做状态 key 会让声明丢失或串到别的会话。
 *
 * 返回 null 表示「没记上」——调用方必须把这个区分透出给模型（ok:false），
 * 否则模型以为报成功了、后续轮次却读不到，比不报更糟。
 */
function _recordAgentTestReport(callOpts, report) {
  if (!_agentStatus || !_agentStatus.recordTestReport) return null;
  const key = callOpts && callOpts._agentStatusKey;
  if (!key) return null;
  return _agentStatus.recordTestReport(key, report);
}

// ★ v9.9.100 · 废除硬编码桩 · 道法自然 · 无为而无以为
//   道义: 四十八章「损之又损 以至于无为」· 硬编码桩是「为」· 配置路由是「无为」
//   v9.9.73c 的 _STUB_MODELS 强制 SWE-1.6 FAST → builtin-stub → 绕过 DeepSeek 路由
//   根因: 硬编码优先级高于配置 → 用户配置了 DeepSeek 路由但不生效
//   修复: 清空 _STUB_MODELS · 让 SWE-1.6 FAST 走配置的 DeepSeek 外接API
//   SWE-1.6 (非FAST) 走官方传输层 · SWE-1.6 FAST 走 DeepSeek 外接API路由层
const _STUB_MODELS = new Set([]); // ★ 废除: 不再强制任何模型走 builtin-stub
const _STUB_TARGET = {
  provider: "builtin-stub",
  model: "stub-transport-test",
  _label: "内建传输层桩 (备用 · 仅在 _STUB_MODELS 非空时启用)",
  maxOutputTokens: 8192,
};

// ★ v9.9.97 · 保护常用模型 · 不允许路由到外接API
//   道义: 二十九章「天下神器 非可为也」· GLM/DeepSeek/Qwen即神器
//   用户显式解锁才可路由 · 否则shouldRoute返回false
//   v9.9.97-fix: 新增family级别匹配 · 新版本自动保护 · 不再硬编码版本号
const _PROTECTED_FAMILIES = new Set(["GLM", "DeepSeek", "Qwen"]);
const _PROTECTED_MODELS = new Set([
  "MODEL_GLM_4_5",
  "MODEL_GLM_4_5_FAST",
  "MODEL_GLM_4_6",
  "MODEL_GLM_4_6_FAST",
  "MODEL_GLM_4_7",
  "MODEL_GLM_4_7_FAST",
  "MODEL_DEEPSEEK_V3_2",
  "MODEL_DEEPSEEK_R1",
  "MODEL_DEEPSEEK_R1_FAST",
  "MODEL_QWEN_3_235B_INSTRUCT",
  "MODEL_QWEN_3_CODER_480B_INSTRUCT",
  // 小写格式兼容
  "glm-4-5",
  "glm-4-5-fast",
  "glm-4-6",
  "glm-4-6-fast",
  "glm-4-7",
  "glm-4-7-fast",
  "deepseek-v3-2",
  "deepseek-r1",
  "deepseek-r1-fast",
  "qwen3-235b-instruct",
  "qwen3-coder-480b-instruct",
]);
// 用户显式解锁的模型(运行时可变)
const _unlockedModels = new Set();

// ★ v9.9.68 · 文件级诊断 · 路由执行全链路追踪
const _routeDiagPath = path.join(
  __dirname,
  "..",
  "..",
  "bundled-origin",
  "_router_diag.log",
);
function _routeDiag(msg) {
  try {
    const t = new Date().toISOString();
    // v9.9.77 · 异步写入 · 反者道之动 · appendFileSync 阻塞事件循环致 ext-host UNRESPONSIVE
    fs.appendFile(_routeDiagPath, `[${t}] ${msg}\n`, () => {});
  } catch {}
}

// ★ 诊断转储门控: 默认关。每请求把完整 SP+tools JSON.stringify 写盘在高并发下
//   明显拖慢请求线程 · 仅排障时开 (_cfg.debugDump=true 或 DAO_DEBUG_DUMP 环境变量)。
function _debugDumpEnabled() {
  try {
    if (_cfg && _cfg.debugDump === true) return true;
  } catch (_) {}
  return process.env.DAO_DEBUG_DUMP === "1" || process.env.DAO_DEBUG_DUMP === "true";
}

// ★ OTEL 导出初始化: 按 _cfg.otel 配置订阅 trace_center 完结事件, 批量送 OTLP。
//   config: _cfg.otel = { enabled, endpoint, headers, serviceName, batchSize, flushIntervalMs }
function _initOtelExporter() {
  // 先解绑旧订阅 / dispose 旧导出器 (init 可能被热重载多次)
  if (_otelUnsubscribe) {
    try { _otelUnsubscribe(); } catch (_) {}
    _otelUnsubscribe = null;
  }
  if (_otelExporter) {
    try { _otelExporter.dispose(); } catch (_) {}
    _otelExporter = null;
  }
  const otelCfg = (_cfg && _cfg.otel) || {};
  if (otelCfg.enabled !== true || !otelCfg.endpoint || !_otelExportFactory || !_traceCenter) {
    return;
  }
  try {
    _otelExporter = _otelExportFactory.createOtelExporter({
      endpoint: otelCfg.endpoint,
      headers: otelCfg.headers,
      serviceName: otelCfg.serviceName || "fomo-flow",
      batchSize: otelCfg.batchSize,
      flushIntervalMs: otelCfg.flushIntervalMs,
      httpPost: _otelHttpPost,
      log: _log,
    });
    if (typeof _traceCenter.onFinish === "function") {
      _otelUnsubscribe = _traceCenter.onFinish((trace) => {
        if (_otelExporter) _otelExporter.exportTrace(trace);
      });
    }
    _log(`[dao-router] ★ OTEL 导出启用 · endpoint=${otelCfg.endpoint}`);
  } catch (e) {
    _log(`[dao-router] OTEL 导出初始化失败: ${e.message}`);
  }
}

// OTLP/HTTP POST (JSON body) · 供 otel_export 依赖注入
function _otelHttpPost(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const mod = url.protocol === "https:" ? require("https") : require("http");
      const payload = Buffer.from(body, "utf8");
      const req = mod.request(
        url,
        {
          method: "POST",
          headers: { ...headers, "Content-Length": payload.length },
          timeout: 8000,
        },
        (resp) => {
          const chunks = [];
          resp.on("data", (d) => chunks.push(d));
          resp.on("end", () => {
            if (resp.statusCode >= 200 && resp.statusCode < 300) resolve();
            else reject(new Error("OTLP HTTP " + resp.statusCode));
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        try { req.destroy(); } catch (_) {}
        reject(new Error("OTLP timeout"));
      });
      req.end(payload);
    } catch (e) {
      reject(e);
    }
  });
}

// ★ 出站脱敏应用 (发往第三方 provider 之前 · _callProvider 内每轮调用)
//   per-route target.outboundRedact 覆盖全局 _cfg.outboundRedact
//   命中且 block 模式 → 抛错拒绝整条请求; redact → 改写; monitor → 只记
// ★ 出站脱敏 Stage (P/ACP Conductor 步骤1 试点): 把原内联脱敏逻辑封成一个阶段。
//   行为与旧 _applyOutboundRedaction 逐字等价 —— 未启用/异常返回原引用, block 由
//   调用方翻译为抛错。后续可把 budget/context/cache/agent-status 同样迁为 Stage。
function _makeRedactStage() {
  return {
    name: "outbound-redact",
    outbound(ctx) {
      if (!_outboundRedact || !Array.isArray(ctx.messages)) return undefined;
      let settings;
      try {
        settings = _outboundRedact.resolveSettings(_cfg, ctx.target);
      } catch (_) {
        return undefined;
      }
      if (!settings || settings.enabled !== true) return undefined;
      let result;
      try {
        result = _outboundRedact.redactMessages(ctx.messages, settings);
      } catch (e) {
        _log(`[dao-router] outbound-redact 异常: ${e.message}`);
        return undefined;
      }
      if (result.findings && result.findings.length > 0) {
        const summary = result.findings
          .map((f) => `${f.name}:${f.count}`)
          .join(",");
        _routeDiag(
          `_callProvider outbound-redact mode=${settings.mode} findings=${summary} changed=${result.changed} blocked=${result.blocked}`,
        );
        if (ctx.callOpts) {
          ctx.callOpts._redactFindings = result.findings;
          if (ctx.callOpts._cacheObservation) {
            ctx.callOpts._cacheObservation.redactFindings = result.findings.length;
          }
        }
      }
      if (result.blocked) {
        return { block: { reason: "outbound_redact", findings: result.findings } };
      }
      return { ctx: { ...ctx, messages: result.messages } };
    },
  };
}

function _getOutboundConductor() {
  if (_outboundConductor) return _outboundConductor;
  if (!_pipeline) return null;
  // 步骤1 只挂脱敏一个阶段; 后续阶段(budget/context/cache/agent-status)逐个迁入。
  _outboundConductor = _pipeline.createConductor([_makeRedactStage()]);
  return _outboundConductor;
}

function _applyOutboundRedaction(messages, target, callOpts) {
  const conductor = _getOutboundConductor();
  if (!conductor) return messages;
  const outcome = conductor.runOutbound({ messages, target, callOpts });
  if (outcome.blocked) {
    const err = new Error(
      `outbound redaction blocked request: ${(outcome.blocked.findings || [])
        .map((f) => f.name)
        .join(", ")}`,
    );
    err.code = "OUTBOUND_REDACT_BLOCKED";
    throw err;
  }
  return outcome.ctx.messages;
}

// ★ Token 预算应用 (route() 无 contextStrategy 时的裁剪路径)
//   修: 此前只记 stats 未写回 messages/tools · 裁剪形同虚设
//   仅在预算生效时替换引用 (无裁剪则保留原引用 · 缓存前缀不动)
function _applyRequestBudget({ messages, tools, system, budget, modelUid }) {
  const untouched = { messages, tools, stats: null };
  if (!_budget) return untouched;
  try {
    const budgetResult = _budget.apply({
      messages,
      tools,
      system: system || "",
      budget: budget || null,
      modelUid,
    });
    const stats = budgetResult.stats;
    const applied =
      stats.messagesTrimmed > 0 ||
      stats.toolsRemoved > 0 ||
      stats.toolsCompacted > 0;
    if (applied) {
      _routeDiag(
        `route() budget.apply: msgs trimmed=${stats.messagesTrimmed} tools rm=${stats.toolsRemoved} cmp=${stats.toolsCompacted} total=${stats.totalInputTokens}/${stats.maxContextTokens}`,
      );
    }
    return {
      messages: applied ? budgetResult.messages : messages,
      tools: applied ? budgetResult.tools : tools,
      stats,
    };
  } catch (e) {
    _log(`[dao-router] budget.apply 异常: ${e.message}`);
    return untouched;
  }
}
let _substituteEnabled = false; // 全局开关: substitute模式默认关闭(需用户有目标模型权限)
let _familyTierExtend = false; // ★ 同族档位延伸: 连一档是否覆盖全族 · 默认关(可显式 familyTierExtend:true 开) · 关时 slow 等未显式连线之档保持官方原生直通(默认走官方·免费不路由) · 开时全族档位归一其渠道
let _wire = null; // cascade_wire.js (lazy load)

// ════════════════════════════════════════════════════════════════
// ★ v9.9.73 · 内建传输层桩 · 零依赖 · 不假外求
//   道义: 三十九章「天得一以清 地得一以宁」· 得一则通
//   用途: swe-1-6 专供传输层验证 · 不依赖任何外部API
//   始终可用 · 始终返回固定响应 · 诊断传输链路每一环节
// ════════════════════════════════════════════════════════════════
const _STUB_TEXT = "道可道也 非恒道也 · 传输层得一 · stub响应正常";
const _STUB_SEQ = [0]; // 自增序号
function _builtinStubResponse(modelUid, messages, tools) {
  _STUB_SEQ[0]++;
  const seq = _STUB_SEQ[0];
  const now = Date.now();
  // ★ v9.9.73a · 始终返回文本 · 不返回 tool_calls
  //   道义: 三十五章「执大象 天下往 往而不害 安平大」
  //   传输层桩的目的是验证帧传输 · 不是模拟工具调用
  //   返回 tool_calls 会导致 Windsurf UI 尝试执行假工具 → 报错
  //   如需测试 tool_calls 传输: 在 system prompt 末尾加 [STUB:TOOL_CALLS]
  var forceToolCall = false;
  if (Array.isArray(messages)) {
    for (var i = 0; i < messages.length; i++) {
      var c = messages[i].content || "";
      if (typeof c === "string" && c.indexOf("[STUB:TOOL_CALLS]") >= 0) {
        forceToolCall = true;
        break;
      }
    }
  }
  var toolCalls = [];
  if (forceToolCall && Array.isArray(tools) && tools.length > 0) {
    var firstTool = tools[0];
    var toolName =
      (firstTool &&
        (firstTool.name || (firstTool.function && firstTool.function.name))) ||
      "read_file";
    toolCalls.push({
      id: "stub_tc_" + seq,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify({ file_path: "/stub/test.txt" }),
      },
    });
  }
  var hasTools = toolCalls.length > 0;
  var obj = {
    id: "stub-" + seq + "-" + now,
    object: "chat.completion",
    created: Math.floor(now / 1000),
    model: modelUid || "stub-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: _STUB_TEXT + " #" + seq,
          tool_calls: hasTools ? toolCalls : undefined,
        },
        finish_reason: hasTools ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  return obj;
}

/**
 * 内建桩 → Connect-RPC Cascade 帧 (复用 _unaryOaToCascade 的帧构造逻辑)
 * 道义: 朴散则为器 · 同一帧构造器 · stub与真实共享
 */
async function _stubToCascade(res, w, modelUid, messages, tools, isJSON) {
  const obj = _builtinStubResponse(modelUid, messages, tools);
  const choice = obj.choices[0];
  const msg = choice.message;
  const _outputId =
    "stub_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const _requestId =
    "stubReq_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const _actualModelUid = modelUid || "swe-1-6-stub";

  // ★ v9.9.78 · message_id + timestamp · 官方后端每帧必含
  //   实证: 官方后端每帧 payload 均含 field 1 (message_id) + field 2 (timestamp)
  //   无 message_id → LSP 无法关联帧 → "Encountered unexpected error"
  //   道义: 三十九章「得一」· 得 message_id + timestamp 方能宁
  const _messageId =
    "bot-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10);
  const _tsMs = Date.now();

  // 每帧必含的 message_id + timestamp 前缀
  const _hdr = () => w.buildFrameHeader(_messageId, _tsMs);

  _routeDiag(
    "_stubToCascade entry: modelUid=" +
      modelUid +
      " messageId=" +
      _messageId +
      " hasTools=" +
      !!(msg.tool_calls && msg.tool_calls.length) +
      " textLen=" +
      (msg.content || "").length,
  );

  // ── 写 Connect-RPC 响应头 ──
  // ★ v9.9.73e · 与官方 API 响应头完全对齐
  //   实证: 官方 API 返回 content-type=application/connect+proto + connect-accept-encoding=gzip
  //   道义: 执今之道以御今之有 · 与官方一致方能通
  if (!res.headersSent) {
    res.writeHead(200, {
      "content-type": isJSON
        ? "application/connect+json"
        : "application/connect+proto",
      "connect-accept-encoding": "gzip",
    });
  }

  // ── 帧 1: metadata (message_id + timestamp + actual_model_uid + output_id + request_id) ──
  //   ★ v9.9.78 · 每帧含 message_id + timestamp · 与官方后端一致
  //   道义: 三十九章「侯王得一以为天下正」· LSP 得此二字段方能归位
  {
    const metaParts = [];
    metaParts.push(_hdr()); // ★ message_id + timestamp
    metaParts.push(w.encodeString(w.RSP.ACTUAL_MODEL_UID, _actualModelUid));
    metaParts.push(w.encodeString(w.RSP.OUTPUT_ID, _outputId));
    metaParts.push(w.encodeString(w.RSP.REQUEST_ID, _requestId));
    const metaFr = w.buildFrame(0, Buffer.concat(metaParts));
    if (metaFr && metaFr.length) res.write(metaFr);
    _routeDiag("_stubToCascade metadata frame: len=" + metaFr.length);
  }

  // ── 帧 2: 文本 (message_id + timestamp + delta_text) ──
  if (typeof msg.content === "string" && msg.content.length > 0) {
    const parts = [];
    parts.push(_hdr()); // ★ message_id + timestamp
    parts.push(w.encodeString(w.RSP.DELTA_TEXT, msg.content));
    const fr = w.buildFrame(0, Buffer.concat(parts));
    if (fr && fr.length) res.write(fr);
    _routeDiag(
      "_stubToCascade text frame: len=" +
        fr.length +
        ' text="' +
        msg.content.slice(0, 60) +
        '"',
    );
  }

  // ── tool_calls 帧 (message_id + timestamp + delta_tool_calls) ──
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const calls = msg.tool_calls.map(function (tc, i) {
      return {
        id: tc.id || "tc_" + i,
        name: (tc.function && tc.function.name) || "",
        argumentsJson: (tc.function && tc.function.arguments) || "{}",
      };
    });
    if (w.encodeChatToolCall) {
      const inner = Buffer.concat([
        _hdr(), // ★ message_id + timestamp
        ...calls.map((tc) =>
          w.encodeMessage(w.RSP.DELTA_TOOL_CALLS, w.encodeChatToolCall(tc)),
        ),
      ]);
      const fr = w.buildFrame(0, inner);
      if (fr && fr.length) {
        res.write(fr);
        _routeDiag("_stubToCascade tool_calls frame: count=" + calls.length);
      }
    }
  }

  // ── stop_reason 帧 (message_id + timestamp + stop_reason) ──
  let stopReason = w.STOP_END;
  if (
    choice.finish_reason === "tool_calls" ||
    choice.finish_reason === "function_call"
  ) {
    stopReason = w.STOP_TOOL_CALLS;
  } else if (choice.finish_reason === "length") {
    stopReason = w.STOP_MAX_TOKENS;
  }
  if (stopReason !== null) {
    const parts = [];
    parts.push(_hdr()); // ★ message_id + timestamp
    parts.push(w.encodeUint(w.RSP.STOP_REASON, stopReason));
    const fr = w.buildFrame(0, Buffer.concat(parts));
    if (fr && fr.length) {
      res.write(fr);
      _routeDiag("_stubToCascade stop_reason frame: reason=" + stopReason);
    }
  }

  // ── end 帧 (含 grpc-status:0) ──
  if (w.buildEndFrame) {
    const fr = w.buildEndFrame(null);
    if (fr && fr.length) {
      res.write(fr);
      _routeDiag("_stubToCascade end frame written");
    }
  }

  // ★ v9.9.78 · 移除 HTTP/2 trailers · EOS 帧已含 grpc-status:0
  //   v9.9.77 添加 addTrailers 是错误方向 · 与 EOS 帧重复
  //   Connect-RPC 规范: EOS 帧 IS the trailer delivery mechanism
  //   道义: 损之又损以至于无为 · 无为而无以为

  if (!res.writableEnded) res.end();
  _log(
    "[dao-router] [stub✓] " +
      modelUid +
      " seq=" +
      _STUB_SEQ[0] +
      " text=" +
      (msg.content || "").length +
      "B tools=" +
      (msg.tool_calls || []).length,
  );
  _routeDiag(
    "_stubToCascade COMPLETE: modelUid=" +
      modelUid +
      " seq=" +
      _STUB_SEQ[0] +
      " headersSent=" +
      res.headersSent +
      " writableEnded=" +
      res.writableEnded,
  );
  return true;
}

// ★ v9.9.288 · 上游错误可读回传 · 反者道之动
//   根因: 上游渠道返回 4xx (如 GitHub Models 免费层限输 8000 token → 真实
//   Cascade 请求 25工具+万字SP 超限 → HTTP 413) 时 · _tryRoute 仅 return false ·
//   route() ALL-FAIL 后亦 return false 且未向 res 写任何帧 → Cascade 端流不闭合 →
//   对话挂起("对话死亡" 30s+)。
//   修复: ALL-FAIL 且响应头未发出时 · 合成一条可读的 assistant 文本帧回传 Cascade
//   (与 _stubToCascade 同帧构造器) · 让用户看到明确错误而非无尽等待。
//   道义: 四十章「反者道之动」· 错误回传即是助 · 不藏其拙。
function _humanUpstreamError(status, provider, bodySnippet) {
  const _p = provider ? `渠道「${provider}」` : "上游渠道";
  const _tail = bodySnippet
    ? `\n\n上游原文: ${String(bodySnippet).slice(0, 300)}`
    : "";
  if (status === 413) {
    return `⚠️ ${_p} 拒绝请求 (HTTP 413 · 请求体过大)。\n\n该渠道对单次输入有 token 上限 (如 GitHub Models 免费层约 8000 token)，而当前请求(系统提示 + 工具定义 + 对话历史)已超限。\n\n建议: ① 换用额度更高的渠道; ② 精简上下文 / 减少同时启用的工具; ③ 新开对话以缩短历史。${_tail}`;
  }
  if (status === 401 || status === 403) {
    return `⚠️ ${_p} 鉴权失败 (HTTP ${status})。API Key 无效、过期或无该模型权限。请在面板②检查该渠道的密钥与权限。${_tail}`;
  }
  if (status === 429) {
    return `⚠️ ${_p} 触发限流 (HTTP 429)。请求过于频繁或额度已耗尽，请稍后重试或更换渠道。${_tail}`;
  }
  if (status === 400 || status === 422) {
    return `⚠️ ${_p} 拒绝请求 (HTTP ${status} · 参数不合法)。可能是该模型不支持当前的工具/参数组合。${_tail}`;
  }
  if (status === 404) {
    return `⚠️ ${_p} 返回 404。该模型名在此渠道不存在，请在面板③确认路由的目标模型名是否正确。${_tail}`;
  }
  return `⚠️ ${_p} 返回错误 HTTP ${status}。请检查渠道配置或稍后重试。${_tail}`;
}

async function _errorToCascade(
  res,
  w,
  modelUid,
  isJSON,
  errText,
  options = {},
) {
  try {
    const _messageId =
      "err-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10);
    const _tsMs = Date.now();
    const _hdr = () => w.buildFrameHeader(_messageId, _tsMs);
    const _outputId =
      "err_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const _requestId =
      "errReq_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const _actualModelUid = modelUid || "dao-router";

    if (!res.headersSent) {
      const statusCode = Number.isInteger(options.httpStatus)
        ? options.httpStatus
        : 200;
      res.writeHead(statusCode, {
        "content-type": isJSON
          ? "application/connect+json"
          : "application/connect+proto",
        "connect-accept-encoding": "gzip",
      });
    }
    // metadata 帧
    {
      const metaParts = [
        _hdr(),
        w.encodeString(w.RSP.ACTUAL_MODEL_UID, _actualModelUid),
        w.encodeString(w.RSP.OUTPUT_ID, _outputId),
        w.encodeString(w.RSP.REQUEST_ID, _requestId),
      ];
      const metaFr = w.buildFrame(0, Buffer.concat(metaParts));
      if (metaFr && metaFr.length) res.write(metaFr);
    }
    // 文本帧 (可读错误)
    {
      const parts = [_hdr(), w.encodeString(w.RSP.DELTA_TEXT, errText)];
      const fr = w.buildFrame(0, Buffer.concat(parts));
      if (fr && fr.length) res.write(fr);
    }
    // stop_reason 帧 (正常结束 · 让 LSP 闭合本轮)
    {
      const parts = [_hdr(), w.encodeUint(w.RSP.STOP_REASON, w.STOP_END)];
      const fr = w.buildFrame(0, Buffer.concat(parts));
      if (fr && fr.length) res.write(fr);
    }
    // end 帧 (grpc-status:0)
    if (w.buildEndFrame) {
      const fr = w.buildEndFrame(null);
      if (fr && fr.length) res.write(fr);
    }
    if (!res.writableEnded) res.end();
    _routeDiag(
      `_errorToCascade SENT: modelUid=${modelUid} len=${errText.length}B`,
    );
    return true;
  } catch (e) {
    _routeDiag(`_errorToCascade EXCEPTION: ${e.message}`);
    try {
      if (!res.writableEnded) res.end();
    } catch {}
    return false;
  }
}

// ── 道直连器健康缓存 (避免每次都探测) ──────────────────────────
const _healthCache = {}; // providerName → { alive: bool, ts: timestamp }
const HEALTH_TTL = 30000; // 30秒缓存
let _cfgWatcher = null; // 配置.json fs.watch 句柄
// ★ 自写抑制: 记录最近一次本进程写盘的内容 · 监听回调据此区分「自写」与「外部手改」
//   根因: 每次热保存(加渠道/解模型)都改写配置.json → 触发 fs.watch → init() 全量重载 →
//         _providers 被替换为新对象 · 与正在进行的「解模型→探活」内存改写打架 →
//         解出的 models 不落、探活退化用渠道名当模型 → 首次添加必失败、须重启+手点探测。
//   修正: 自写内容与磁盘一致时跳过热重载 · 仅外部手改方重载 (道法自然·不扰己流)。
let _lastSelfWriteData = null;

// ★ v9.9.81 · 服务端工具补充 · init() 中填充
//   LSP 不发这些工具但官方后端知道 → DeepSeek 需要才能调用
let _serverToolDefs = [];
let _serverToolNames = new Set();

// ★ v9.9.93 · 修法⑧ · 工具分类: LSP有执行器 vs 仅代理执行
//   根因: trajectory_search 等工具 LSP 本身有执行器 (向量搜索/代码搜索/UI交互)
//   但因缺少 nativeRules → LSP 没在请求中发送定义 → 被错误拦截为"服务端工具"
//   Go EXE 不区分服务端/LSP工具 → 所有 tool_call 直接透传 → LSP 自己执行
//   道义: 十七章「太上不知有之」· LSP 不知有代理 · 工具调用自然流转
//
//   _lspCapableToolNames: LSP 有执行器 → tool_call 透传给 LSP (不拦截)
//     trajectory_search: LSP 内部有向量搜索执行器
//     code_search: LSP 内部有代码搜索子代理
//     ask_user_question: LSP 内部有 UI 交互
//     create_memory: LSP 内部有记忆存储
//     search_web: LSP 内部有搜索执行器
//     read_url_content: LSP 内部有 URL 读取
//     view_content_chunk: LSP 内部有内容查看
//     read_resource: LSP 内部有资源读取
//     edit_notebook / read_notebook: LSP 内部有笔记本操作
//
//   _proxyOnlyToolNames: LSP 无执行器 → 代理执行 + 内部重试
//     deploy_web_app / read_deployment_config / check_deploy_status: 需外部服务
//     skill: 需外部服务
const _lspCapableToolNames = new Set([
  "trajectory_search",
  "code_search",
  "ask_user_question",
  "create_memory",
  "search_web",
  "read_url_content",
  "view_content_chunk",
  "read_resource",
  "edit_notebook",
  "read_notebook",
]);
const _proxyOnlyToolNames = new Set([
  "deploy_web_app",
  "read_deployment_config",
  "check_deploy_status",
  "skill",
  "dao_tool_search",
  "dao_read_tool_output",
  // 测试结果自报 · 代理层执行(写 agent_status)，LSP 无对应执行器 → 必须拦截
  "dao_report_test_result",
]);

// At the retry ceiling, suppress only proxy-local search/deferred helpers.
// Keep Devin/LSP execution tools and connector tools available so the model
// can still inspect, edit, and verify the workspace before it summarizes.
const _retrySuppressedToolNames = new Set([
  ..._proxyOnlyToolNames,
  "code_search",
  "CodeSearch",
  "smart_reading",
  "SmartReading",
  "grep_search",
  "Grep",
  "GrepSearch",
  "find_by_name",
  "FindByName",
]);

function _toolFunctionName(tool) {
  const fn = tool && (tool.function || tool);
  return String((fn && (fn.name || tool.name)) || "");
}

function _filterRetryTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (tool) => !_retrySuppressedToolNames.has(_toolFunctionName(tool)),
  );
}

// ★ v9.9.88 · 工具白名单 (移植自 EXE parse-request.js KNOWN_TOOL_NAMES)
//   道义: 二十八章「大制无割」· 知其可用方传 · 不知则不传
//   规则: 白名单内 → 保留 | mcp\d+_ 前缀 + allowMcp → 保留 | 其他 → 丢弃
//   效果: 防止无效工具名传给上游模型 → 模型调用失败
//
//   ★ v9.9.88b · LSP 别名兼容
//   LSP 发来的工具名有两种风格:
//     标准名: grep_search, run_command (protobuf schema 定义)
//     LSP别名: Grep, bash (LSP 内部使用)
//   两种都必须保留 · 否则 DeepSeek 无法调用 Grep/bash
const _KNOWN_TOOL_NAMES = new Set([
  // 标准名 (protobuf schema)
  "read_file",
  "edit",
  "multi_edit",
  "write_to_file",
  "run_command",
  "grep_search",
  "find_by_name",
  "list_dir",
  "code_search",
  "command_status",
  "browser_preview",
  "todo_list",
  "ask_user_question",
  "deploy_web_app",
  "read_deployment_config",
  "check_deploy_status",
  "create_memory",
  "search_web",
  "read_url_content",
  "view_content_chunk",
  "skill",
  "edit_notebook",
  "read_notebook",
  "trajectory_search",
  "read_resource",
  "dao_tool_search",
  "dao_read_tool_output",
  // LSP 别名 (LSP 发来的实际名称)
  // ★ v9.9.88b · LSP 别名兼容 · 两种都必须保留 · 否则 DeepSeek 无法调用
  //   标准名: read_file, grep_search (protobuf schema 定义)
  //   LSP别名: Read, Grep (LSP 内部使用)
  "Grep",
  "bash",
  "list_resources",
  "read_terminal",
  "Read",
  "Edit",
  "Write",
  "ListDir",
  "FindByName",
  "CodeSearch",
  "RunCommand",
  "GrepSearch",
]);
let _allowMcpTools = true; // 默认允许 MCP 工具 (mcp\d+_ 前缀)

// ★ v9.9.88 · compactPromptText (移植自 EXE parse-request.js)
//   压缩 SP 多余空白 · 统一换行 · 去行尾空白 · 压缩空行
//   道义: 损之又损 · 去其冗余 · 留其精华
function _compactPromptText(text) {
  if (!text || typeof text !== "string") return text || "";
  return text
    .replace(/\r\n/g, "\n") // 统一换行
    .replace(/[ \t]+\n/g, "\n") // 去行尾空白
    .replace(/\n{3,}/g, "\n\n") // 压缩3+空行为2空行
    .trim();
}

// ── 统计 ──────────────────────────────────────────────────────
const _stats = {
  total: 0, // 总路由判断次数
  routed: 0, // 成功路由到cascadeRelay
  fallbackRouted: 0, // 成功路由到fallback provider
  passthru: 0, // 回落官方 (不在路由表)
  errorFallback: 0, // 主路由失败→fallback
  errors: 0, // 致命错误
};

// ── 用量聚合 (v9.9.301) · 内存态 · 供「外接API」面板查看 ──
//   道义: 四十四章「知足不辱 知止不殆」· 知其所耗 · 方知所止
const _usage = {}; // providerName → {input,output,cached,cacheWrite,cacheInput,calls,since,models:{model:{input,output,cached,cacheWrite,cacheInput,calls}}}
const _cacheSamples = [];
const _requestHistorySamples = [];
const _CACHE_SAMPLE_LIMIT = 200;
const _CACHE_SAMPLE_LIMIT_PER_PROVIDER = 40;
const _CACHE_RECENT_WINDOW = 5;
const _CACHE_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let _cacheHistoryPath = null;
let _cacheHistoryWriteTimer = null;
const _promptCacheKeyUnsupported = new Set();
const _upstreamCircuits = new Map();
// 路由建议只记录脱敏的决策快照；它不是调度队列，也不参与 priority 路由排序。
const _routingDecisions = [];
const _ROUTING_DECISION_LIMIT = 20;
const _ROUTING_DECISION_CANDIDATE_LIMIT = 16;
const _ROUTING_DECISION_TTL_MS = 30 * 60 * 1000;
let _routingDecisionSequence = 0;

function _finiteHistoryTimestamp(value) {
  const at = Number(value);
  return Number.isFinite(at) && at > 0 ? at : 0;
}

function _safeHistorySample(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const at = _finiteHistoryTimestamp(value.at);
  const provider = String(value.provider || "")
    .trim()
    .slice(0, 100);
  const model = String(value.model || "")
    .trim()
    .slice(0, 120);
  if (!at || !provider || !model) return null;
  return {
    ...value,
    at,
    provider,
    model,
  };
}

function _retainBoundedSamples(samples) {
  // 按渠道封顶再套全局上限：单一渠道洪流（例如 GLM）不得把 ay/terra 的
  // 会话缓存样本从环形缓冲里挤掉，否则 HUD 会把真命中显示成「暂无样本」。
  const newestFirst = [];
  const keptPerProvider = new Map();
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (!sample || typeof sample !== "object") continue;
    const provider = String(sample.provider || "").trim();
    if (!provider) continue;
    const kept = keptPerProvider.get(provider) || 0;
    if (kept >= _CACHE_SAMPLE_LIMIT_PER_PROVIDER) continue;
    if (newestFirst.length >= _CACHE_SAMPLE_LIMIT) continue;
    newestFirst.push(sample);
    keptPerProvider.set(provider, kept + 1);
  }
  samples.length = 0;
  for (let index = newestFirst.length - 1; index >= 0; index -= 1) {
    samples.push(newestFirst[index]);
  }
  return samples;
}

function _loadRequestHistory(historyPath) {
  _requestHistorySamples.length = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    const samples = Array.isArray(raw) ? raw : raw && raw.samples;
    if (!Array.isArray(samples)) return;
    const cutoff = Date.now() - _CACHE_HISTORY_MAX_AGE_MS;
    for (const item of samples.slice(-_CACHE_SAMPLE_LIMIT)) {
      const sample = _safeHistorySample(item);
      if (sample && sample.at >= cutoff) _requestHistorySamples.push(sample);
    }
    _retainBoundedSamples(_requestHistorySamples);
  } catch (_) {
    // A missing or corrupt optional history must never block the router.
  }
}

function _flushRequestHistory() {
  _cacheHistoryWriteTimer = null;
  if (!_cacheHistoryPath) return;
  try {
    const dir = path.dirname(_cacheHistoryPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${_cacheHistoryPath}.tmp-${process.pid}`;
    const payload = JSON.stringify({
      version: 1,
      samples: _requestHistorySamples.slice(-_CACHE_SAMPLE_LIMIT),
    });
    fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, _cacheHistoryPath);
  } catch (_) {
    // Observability history is best effort and must not affect routing.
  }
}

function _scheduleRequestHistoryWrite() {
  if (!_cacheHistoryPath) return;
  if (_cacheHistoryWriteTimer) clearTimeout(_cacheHistoryWriteTimer);
  _cacheHistoryWriteTimer = setTimeout(_flushRequestHistory, 250);
  if (_cacheHistoryWriteTimer.unref) _cacheHistoryWriteTimer.unref();
}

function _routingSafeText(value, maxLength = 100) {
  return String(value == null ? "" : value).slice(0, maxLength);
}

function _routingFailureClass(failure) {
  const status = Number(failure && failure.status);
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "quota";
  if (status === 400 || status === 413 || status === 422) return "request";
  if (status === 0) return "transport";
  if (status >= 500) return "upstream";
  return failure ? "unavailable" : "unknown";
}

function _routingRounded(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const scale = 10 ** digits;
  return Math.round(numeric * scale) / scale;
}

function _routingClampLimit(value) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) return _ROUTING_DECISION_LIMIT;
  return Math.max(1, Math.min(_ROUTING_DECISION_LIMIT, numeric));
}

function _routingProfile(profile) {
  return _routingProfiles &&
    typeof _routingProfiles.normalizeProfile === "function"
    ? _routingProfiles.normalizeProfile(profile)
    : "balanced";
}

function _planRoute(input = {}) {
  if (!_routePlanner || typeof _routePlanner.createRoutePlan !== "function") {
    throw new Error("route planner unavailable");
  }
  return _routePlanner.createRoutePlan({
    mode: input.mode,
    planId: input.planId,
    model: input.modelUid,
    strategy: _channelStrategy(input.target),
    profile: _routingProfile(input.profile),
    candidates: input.candidates,
    providers: input.providers || _providers,
    circuits: input.circuits || _upstreamCircuits,
    request: input.request || {},
    budget: input.budget || null,
    cacheAffinityProvider: input.cacheAffinityProvider,
    now: input.now,
  });
}

function _routingWeights(profile) {
  if (
    _routingProfiles &&
    typeof _routingProfiles.weightsForProfile === "function"
  ) {
    return _routingProfiles.weightsForProfile(profile);
  }
  return _channelScorer ? _channelScorer.WEIGHTS : {};
}

function _routingRequestHeader(req, name) {
  const headers = req && req.headers;
  if (!headers) return undefined;
  const expected = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === expected) return value;
  }
  return undefined;
}

function _pruneRoutingDecisions(now = Date.now()) {
  const cutoff = now - _ROUTING_DECISION_TTL_MS;
  while (_routingDecisions.length && _routingDecisions[0].atMs < cutoff) {
    _routingDecisions.shift();
  }
  while (_routingDecisions.length > _ROUTING_DECISION_LIMIT) {
    _routingDecisions.shift();
  }
}

function _routingPricingCandidate(entry, priority) {
  const target = (entry && entry.target) || {};
  const pricing = (_providers[target.provider] || {}).pricing || {};
  const inPer1k = Number(pricing.inPer1k);
  const outPer1k = Number(pricing.outPer1k);
  const hasKnownPrice =
    Number.isFinite(inPer1k) &&
    Number.isFinite(outPer1k) &&
    inPer1k >= 0 &&
    outPer1k >= 0;
  return {
    provider: target.provider,
    model: target.model,
    _priority: priority,
    _estimatedCostPer1k: hasKnownPrice
      ? inPer1k * 0.7 + outPer1k * 0.3
      : undefined,
    _freeTier: hasKnownPrice && inPer1k === 0 && outPer1k === 0,
  };
}

function _routingFactorSnapshot(breakdown) {
  const factors = {};
  const names =
    _routingProfiles && typeof _routingProfiles.factorNames === "function"
      ? _routingProfiles.factorNames()
      : Object.keys((_channelScorer && _channelScorer.WEIGHTS) || {});
  for (const name of names) {
    const value = _routingRounded(breakdown && breakdown[name]);
    factors[name] = value == null ? 0 : Math.max(0, Math.min(1, value));
  }
  return factors;
}

function _rankRoutingFactors(candidates, profile) {
  const weights = _routingWeights(profile);
  return candidates
    .map((candidate) => ({
      ...candidate,
      advisoryScore: _routingRounded(
        Object.entries(weights).reduce(
          (score, [factor, weight]) =>
            score + (candidate.factors[factor] || 0) * weight,
          0,
        ),
      ),
    }))
    .sort(
      (left, right) =>
        right.advisoryScore - left.advisoryScore ||
        left.actualPriority - right.actualPriority,
    )
    .map((candidate, index) => ({ ...candidate, advisoryRank: index + 1 }));
}

function _buildRoutingDecision({
  candidates,
  profile,
  target,
  callOpts,
  modelUid,
}) {
  const actualCandidates = Array.isArray(candidates)
    ? candidates.slice(0, _ROUTING_DECISION_CANDIDATE_LIMIT)
    : [];
  const scoringCandidates = actualCandidates.map(_routingPricingCandidate);
  const costs = scoringCandidates
    .map((candidate) => candidate._estimatedCostPer1k)
    .filter((cost) => Number.isFinite(cost));
  const scoringContext = {
    circuits: _upstreamCircuits,
    weights: _routingWeights(profile),
    costRange: costs.length
      ? { min: Math.min(...costs), max: Math.max(...costs) }
      : null,
    cacheAffinityProvider:
      (
        actualCandidates.find((candidate) => _isStickySource(candidate.source)) ||
        {}
      ).target?.provider || null,
    callOpts: {
      stream: !callOpts || callOpts.stream !== false,
      tools: callOpts && callOpts.tools,
      thinkingEnabled: callOpts && callOpts.thinkingEnabled,
      reasoningEffort: callOpts && callOpts.reasoningEffort,
    },
  };
  const ranked =
    _channelScorer && typeof _channelScorer.rankChannels === "function"
      ? _channelScorer.rankChannels(scoringCandidates, scoringContext)
      : scoringCandidates;
  const rankedByKey = new Map(
    ranked.map((candidate) => [
      `${candidate.provider}|${candidate.model}`,
      candidate,
    ]),
  );
  const rawRows = actualCandidates.map((entry, index) => {
    const channel = (entry && entry.target) || {};
    const scored =
      rankedByKey.get(`${channel.provider}|${channel.model}`) || {};
    return {
      provider: _routingSafeText(channel.provider),
      model: _routingSafeText(channel.model),
      source: _routingSafeText(entry && entry.source),
      actualPriority: index + 1,
      factors: _routingFactorSnapshot(scored._scoreBreakdown),
    };
  });
  const now = Date.now();
  return {
    id: `route-${now.toString(36)}-${(++_routingDecisionSequence).toString(36)}`,
    atMs: now,
    at: new Date(now).toISOString(),
    model: _routingSafeText(modelUid || (target && target._routeUid)),
    channelStrategy: _channelStrategy(target),
    mode: "advisory",
    profile: _routingProfile(profile),
    candidates: _rankRoutingFactors(rawRows, profile),
    selected: null,
    outcome: { status: "pending", failureClass: "" },
    budget: {
      status: "not_requested",
      capUsd: null,
      fallback: null,
      budget_override: null,
      overBudgetFallback: false,
    },
  };
}

function _recordRoutingDecision(input) {
  const decision = _buildRoutingDecision(input || {});
  _pruneRoutingDecisions();
  _routingDecisions.push(decision);
  _pruneRoutingDecisions();
  return decision;
}

function _recordRoutingDecisionFromPlan(plan) {
  const advisoryByPriority = new Map(
    (Array.isArray(plan && plan.advisoryOrder) ? plan.advisoryOrder : []).map(
      (candidate) => [candidate.actualPriority, candidate],
    ),
  );
  const atMs = Date.parse(plan && plan.createdAt) || Date.now();
  const decision = {
    id: _routingSafeText(plan && plan.planId, 96),
    atMs,
    at: new Date(atMs).toISOString(),
    model: _routingSafeText(plan && plan.model),
    channelStrategy: plan && plan.strategy === "random" ? "random" : "priority",
    mode: "advisory",
    profile: _routingProfile(plan && plan.profile),
    candidates: (Array.isArray(plan && plan.configuredOrder)
      ? plan.configuredOrder
      : []
    ).map((candidate) => {
      const advisory = advisoryByPriority.get(candidate.actualPriority) || {};
      return {
        provider: _routingSafeText(candidate.provider),
        model: _routingSafeText(candidate.model),
        source: _routingSafeText(candidate.source),
        actualPriority: candidate.actualPriority,
        advisoryRank: advisory.advisoryRank || null,
        advisoryScore: _routingRounded(advisory.advisoryScore),
        factors: _routingFactorSnapshot(advisory.factors),
      };
    }),
    selected: null,
    outcome: { status: "pending", failureClass: "" },
    budget: { ...(plan && plan.budget) },
  };
  _pruneRoutingDecisions();
  _routingDecisions.push(decision);
  _pruneRoutingDecisions();
  return decision;
}

function _setRoutingDecisionOutcome(decision, outcome) {
  if (!decision || !outcome) return;
  const selected = outcome.target || {};
  const selectedProvider = _routingSafeText(selected.provider);
  const selectedModel = _routingSafeText(selected.model);
  decision.outcome = {
    status:
      outcome.status === "selected"
        ? "selected"
        : outcome.status === "budget_rejected"
          ? "budget_rejected"
          : "exhausted",
    provider: selectedProvider,
    model: selectedModel,
    actualPriority:
      decision.candidates.find(
        (candidate) =>
          candidate.provider === selectedProvider &&
          candidate.model === selectedModel,
      )?.actualPriority || null,
    failureCount: Math.max(0, Number(outcome.failureCount) || 0),
    failureClass: _routingSafeText(outcome.failureClass, 40),
  };
  decision.selected =
    outcome.status === "selected"
      ? { provider: selectedProvider, model: selectedModel }
      : null;
}

function getRoutingDecisions(profile, limit) {
  _pruneRoutingDecisions();
  const normalizedProfile = _routingProfile(profile);
  const boundedLimit = _routingClampLimit(limit);
  return _routingDecisions
    .slice()
    .reverse()
    .slice(0, boundedLimit)
    .map((decision) => ({
      id: decision.id,
      at: decision.at,
      model: decision.model,
      channelStrategy: decision.channelStrategy,
      mode: "advisory",
      profile: normalizedProfile,
      candidates: _rankRoutingFactors(
        decision.candidates,
        normalizedProfile,
      ).map((candidate) => ({
        provider: candidate.provider,
        model: candidate.model,
        source: candidate.source,
        actualPriority: candidate.actualPriority,
        advisoryRank: candidate.advisoryRank,
        advisoryScore: candidate.advisoryScore,
        factors: { ...candidate.factors },
      })),
      selected: decision.selected ? { ...decision.selected } : null,
      outcome: { ...decision.outcome },
      budget: { ...decision.budget },
    }));
}

const _PREFLIGHT_FIELDS = new Set([
  "model",
  "profile",
  "budgetUsd",
  "budgetFallback",
  "inputTokens",
  "maxOutputTokens",
  "stream",
  "usesTools",
  "thinkingEnabled",
  "reasoningEffort",
]);

function _preflightError(status, code, message) {
  return { ok: false, status, error: { code, message } };
}

function _normalizePreflightInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return _preflightError(400, "INVALID_PREFLIGHT", "预演输入必须是对象");
  }
  const unknown = Object.keys(value).find((key) => !_PREFLIGHT_FIELDS.has(key));
  if (unknown) {
    return _preflightError(
      400,
      "INVALID_PREFLIGHT",
      `预演不接受字段 ${unknown}`,
    );
  }
  if (
    typeof value.model !== "string" ||
    !value.model.trim() ||
    value.model.length > 120
  ) {
    return _preflightError(
      400,
      "INVALID_PREFLIGHT",
      "model 必须是 1 到 120 字符的模型标识",
    );
  }
  const profile =
    value.profile == null
      ? "balanced"
      : String(value.profile).trim().toLowerCase();
  if (!_routingProfiles || !_routingProfiles.PROFILE_IDS.includes(profile)) {
    return _preflightError(
      400,
      "INVALID_PREFLIGHT",
      "profile 不是支持的预演场景",
    );
  }
  const booleanFields = ["stream", "usesTools", "thinkingEnabled"];
  for (const field of booleanFields) {
    if (value[field] != null && typeof value[field] !== "boolean") {
      return _preflightError(400, "INVALID_PREFLIGHT", `${field} 必须是布尔值`);
    }
  }
  const boundedNumber = (field, minimum, maximum, integer) => {
    if (value[field] == null) return null;
    const number = Number(value[field]);
    if (
      !Number.isFinite(number) ||
      number < minimum ||
      number > maximum ||
      (integer && !Number.isInteger(number))
    ) {
      return _preflightError(400, "INVALID_PREFLIGHT", `${field} 超出允许范围`);
    }
    return number;
  };
  const inputTokens = boundedNumber("inputTokens", 0, 1_000_000, true);
  if (inputTokens && inputTokens.ok === false) return inputTokens;
  const maxOutputTokens = boundedNumber("maxOutputTokens", 1, 1_000_000, true);
  if (maxOutputTokens && maxOutputTokens.ok === false) return maxOutputTokens;
  const budgetUsd = boundedNumber("budgetUsd", 0.000001, 1_000, false);
  if (budgetUsd && budgetUsd.ok === false) return budgetUsd;
  const budgetFallback =
    value.budgetFallback == null ? null : value.budgetFallback;
  if (
    budgetFallback != null &&
    !["strict", "cheapest"].includes(budgetFallback)
  ) {
    return _preflightError(
      400,
      "INVALID_PREFLIGHT",
      "budgetFallback 只支持 strict 或 cheapest",
    );
  }
  if (budgetFallback != null && budgetUsd == null) {
    return _preflightError(
      400,
      "INVALID_PREFLIGHT",
      "设置预算处理方式前必须填写 budgetUsd",
    );
  }
  const reasoningEffort =
    value.reasoningEffort == null ? null : String(value.reasoningEffort);
  if (
    reasoningEffort != null &&
    !["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(
      reasoningEffort,
    )
  ) {
    return _preflightError(
      400,
      "INVALID_PREFLIGHT",
      "reasoningEffort 不是支持的级别",
    );
  }
  return {
    ok: true,
    value: {
      model: value.model.trim(),
      profile,
      budgetUsd,
      budgetFallback: budgetUsd == null ? null : budgetFallback || "strict",
      inputTokens,
      maxOutputTokens,
      stream: value.stream !== false,
      usesTools: value.usesTools === true,
      thinkingEnabled: value.thinkingEnabled === true,
      reasoningEffort,
    },
  };
}

function preflightRoute(input) {
  if (!_ready || !_routeDecisionStore) {
    return _preflightError(
      503,
      "RUNTIME_UNAVAILABLE",
      "本地路由运行时尚未就绪",
    );
  }
  const normalized = _normalizePreflightInput(input);
  if (!normalized.ok) return normalized;
  const request = normalized.value;
  const resolved = resolveRoute(request.model);
  if (!resolved || !shouldRoute(request.model)) {
    return _preflightError(
      404,
      "ROUTE_NOT_FOUND",
      "当前配置中没有可预演的模型路由",
    );
  }
  const target = resolved.route;
  const callOpts = {
    tools: request.usesTools ? [{}] : [],
    maxOutputTokens: request.maxOutputTokens || target.maxOutputTokens || 32768,
    stream: request.stream,
    thinkingEnabled: request.thinkingEnabled,
    reasoningEffort: request.reasoningEffort,
  };
  const candidates = _buildDispatchCandidates(target, callOpts);
  const providers =
    target.provider === "builtin-stub"
      ? {
          ..._providers,
          "builtin-stub": {
            enabled: true,
            pricing: { inPer1k: 0, outPer1k: 0 },
          },
        }
      : _providers;
  const plan = _planRoute({
    mode: "preflight",
    candidates,
    providers,
    target,
    modelUid: request.model,
    profile: request.profile,
    budget:
      request.budgetUsd == null
        ? null
        : { capUsd: request.budgetUsd, fallback: request.budgetFallback },
    request: {
      inputTokens: request.inputTokens,
      maxOutputTokens: callOpts.maxOutputTokens,
      stream: request.stream,
      usesTools: request.usesTools,
      thinkingEnabled: request.thinkingEnabled,
      reasoningEffort: request.reasoningEffort,
    },
  });
  _routeDecisionStore.reservePreflight(plan, request);
  return {
    ok: true,
    status: 200,
    plan,
    message: "只是预演，不会发送请求或改变优先级。",
  };
}

function getDecisionInbox(limit) {
  return _routeDecisionStore ? _routeDecisionStore.listInbox(limit) : [];
}

function acknowledgeDecision(id) {
  return _routeDecisionStore
    ? _routeDecisionStore.acknowledge(String(id || ""))
    : null;
}

function snoozeDecision(id, minutes) {
  const bounded = Math.max(
    1,
    Math.min(7 * 24 * 60, Math.floor(Number(minutes) || 0)),
  );
  return _routeDecisionStore
    ? _routeDecisionStore.snooze(
        String(id || ""),
        Date.now() + bounded * 60 * 1000,
      )
    : null;
}

function getRouteEvidence(limit) {
  return _routeDecisionStore ? _routeDecisionStore.listEvidence(limit) : [];
}

function _clearRoutingDecisions() {
  _routingDecisions.length = 0;
}

function _routingInputTokens(callOpts) {
  try {
    const body = JSON.stringify((callOpts && callOpts.messages) || []);
    return Math.max(
      0,
      Math.min(1_000_000, Math.ceil(Buffer.byteLength(body, "utf8") / 4)),
    );
  } catch (_) {
    return null;
  }
}

function _dispatchRoutePlan({ req, candidates, target, callOpts, modelUid }) {
  const budget =
    _routingProfiles &&
    typeof _routingProfiles.parseRequestBudget === "function"
      ? _routingProfiles.parseRequestBudget((req && req.headers) || {})
      : null;
  return _planRoute({
    mode: "dispatch",
    candidates,
    target,
    modelUid,
    profile: _routingRequestHeader(req, "x-dao-routing-profile"),
    budget,
    request: {
      inputTokens: _routingInputTokens(callOpts),
      maxOutputTokens: callOpts && callOpts.maxOutputTokens,
      stream: !callOpts || callOpts.stream !== false,
      usesTools: Boolean(
        callOpts && Array.isArray(callOpts.tools) && callOpts.tools.length,
      ),
      thinkingEnabled: callOpts && callOpts.thinkingEnabled === true,
      reasoningEffort: callOpts && callOpts.reasoningEffort,
    },
    cacheAffinityProvider:
      (candidates.find((candidate) => _isStickySource(candidate.source)) || {})
        .target?.provider || null,
  });
}

function _routePlanMetadata(req, modelUid, callOpts, plan) {
  return {
    model: modelUid,
    profile: _routingProfile(
      _routingRequestHeader(req, "x-dao-routing-profile"),
    ),
    budgetUsd: plan && plan.budget ? plan.budget.capUsd : null,
    budgetFallback: plan && plan.budget ? plan.budget.fallback : null,
    stream: !callOpts || callOpts.stream !== false,
    usesTools: Boolean(callOpts && callOpts._requestUsesTools),
    thinkingEnabled: Boolean(callOpts && callOpts.thinkingEnabled),
    reasoningEffort: (callOpts && callOpts.reasoningEffort) || null,
  };
}

function _routingBudgetPlan(req, candidates, callOpts) {
  if (
    !_routingProfiles ||
    typeof _routingProfiles.parseRequestBudget !== "function"
  ) {
    return {
      status: "not_requested",
      budget: null,
      reject: false,
      preferredIndex: null,
    };
  }
  const budget = _routingProfiles.parseRequestBudget(
    (req && req.headers) || {},
  );
  if (!budget || typeof _routingProfiles.evaluateRequestBudget !== "function") {
    return {
      status: "not_requested",
      budget: null,
      reject: false,
      preferredIndex: null,
    };
  }
  const inputTokens = _routingInputTokens(callOpts);
  const plan = _routingProfiles.evaluateRequestBudget({
    budget,
    inputTokens,
    maxOutputTokens: callOpts && callOpts.maxOutputTokens,
    candidates: (Array.isArray(candidates) ? candidates : []).map(
      (candidate) => {
        const target = (candidate && candidate.target) || {};
        return {
          pricing: (_providers[target.provider] || {}).pricing,
          maxOutputTokens: target.maxOutputTokens,
        };
      },
    ),
  });
  return { ...plan, budget };
}

function _setRoutingDecisionBudget(decision, plan) {
  if (!decision || !plan) return;
  decision.budget = {
    status: _routingSafeText(plan.status, 40),
    capUsd: plan.budget ? _routingRounded(plan.budget.capUsd, 6) : null,
    fallback: plan.budget ? plan.budget.fallback : null,
    budget_override: plan.status === "cheapest_override" ? "cheapest" : null,
    overBudgetFallback: plan.status === "cheapest_override",
  };
}
// ★ 熔断降敏: 瞬时失败累计到阈值才开闸 (非 401/余额/404 等硬故障)
const _circuitStrikes = new Map(); // circuitKey → { count, lastAt, lastStatus }
// ★ 熔断期暂存会话亲和 · 探活成功后接回 (不丢 sticky / prompt cache)
const _parkedConversationAffinity = new Map(); // affinityKey → value
const _conversationProviderAffinity = new Map();
// 熔断策略默认值 · 每次 init 都从此基线重建，避免热重载继承旧配置。
const _DEFAULT_CIRCUIT_POLICY = Object.freeze({
  strikeThreshold: 5, // 抗抖动: 瞬时失败累计 N 次才熔断
  strikeWindowMs: 60 * 1000, // 累计窗口
  probeLeadMs: 5 * 1000, // TTL 期满前探活提前量
  earlyProbeMs: 8 * 1000, // 熔断后最早探活时间 (不等到 TTL 末尾)
  restoreAffinity: true, // 探活成功后接回会话亲和
  probeIntervalMs: 5 * 1000, // 探活失败后周期重探间隔 (不等 TTL 自然过期)
});
let _circuitPolicy = { ..._DEFAULT_CIRCUIT_POLICY };
const _localToolTranscriptByConversation = new Map();
// 只读工具结果短缓存：不覆盖编辑/部署/网络工具，避免副作用与陈旧写入。
const _readOnlyToolCache = new Map();
const _READ_ONLY_TOOL_CACHE_TTL_MS = 2 * 60 * 1000;
const _READ_ONLY_TOOL_CACHE_LIMIT = 256;
const _READ_ONLY_TOOL_NAMES = new Set([
  "code_search",
  "CodeSearch",
  "SmartReading",
  "smart_reading",
  "grep_search",
  "Grep",
  "GrepSearch",
  "find_by_name",
  "FindByName",
]);

function _readOnlyToolCacheKey(name, argsJson, callOpts) {
  const roots = Array.isArray(callOpts && callOpts._workspaceRoots)
    ? callOpts._workspaceRoots.join("|")
    : "";
  return crypto
    .createHash("sha256")
    .update(`${name}|${roots}|${argsJson || "{}"}`, "utf8")
    .digest("hex");
}

function _executeCachedReadOnlyTool(name, argsJson, callOpts) {
  const now = Date.now();
  const key = _readOnlyToolCacheKey(name, argsJson, callOpts);
  const cached = _readOnlyToolCache.get(key);
  if (cached && now - cached.at <= _READ_ONLY_TOOL_CACHE_TTL_MS) {
    cached.hits++;
    return cached.value;
  }
  if (cached) _readOnlyToolCache.delete(key);
  const value = _localWorkspaceTools.execute(name, argsJson);
  // 缓存仅限明确成功的 JSON 结果，避免把错误或不可用状态扩大化。
  try {
    const parsed = JSON.parse(value);
    if (parsed && parsed.ok !== false && parsed.status !== "error") {
      _readOnlyToolCache.set(key, { value, at: now, hits: 0, name });
      while (_readOnlyToolCache.size > _READ_ONLY_TOOL_CACHE_LIMIT) {
        _readOnlyToolCache.delete(_readOnlyToolCache.keys().next().value);
      }
    }
  } catch {}
  return value;
}
const _customModelRegistry = createCustomModelRegistry({
  getCustomModels: () => _customModels,
  getProviders: () => _providers,
  getRoutes: () => _routes,
  customModelRuntime: _customModelRuntime,
  conversationProviderAffinity: _conversationProviderAffinity,
  get modelCapabilities() {
    return _modelCapabilities;
  },
  pickContextLength: (model) =>
    _adapters && typeof _adapters.pickContextLength === "function"
      ? _adapters.pickContextLength(model)
      : 131072,
  hotAddRoute: (...args) => hotAddRoute(...args),
  saveConfig: () => _hotSaveConfig(),
});

const _CONVERSATION_AFFINITY_LIMIT = 256;
const _CONVERSATION_AFFINITY_TTL_MS = 2 * 60 * 60 * 1000;
const _LOCAL_TOOL_TRANSCRIPT_GROUP_LIMIT = 64;

function _toolCallIds(messages) {
  const ids = new Set();
  for (const message of messages || []) {
    if (message && message.tool_call_id) ids.add(message.tool_call_id);
    for (const toolCall of (message && message.tool_calls) || []) {
      if (toolCall && toolCall.id) ids.add(toolCall.id);
    }
  }
  return ids;
}

function _rememberLocalToolTranscript(key, messages, anchorToolCallIds) {
  if (!key || !Array.isArray(messages) || messages.length === 0) return;
  const callIds = Array.from(_toolCallIds(messages));
  if (callIds.length === 0) return;
  const now = Date.now();
  let state = _localToolTranscriptByConversation.get(key);
  if (!state || now - state.updatedAt > _CONVERSATION_AFFINITY_TTL_MS) {
    state = { groups: [], updatedAt: now };
  }
  if (
    state.groups.some((group) =>
      group.callIds.some((id) => callIds.includes(id)),
    )
  ) {
    return;
  }
  state.groups.push({
    callIds,
    anchorToolCallIds: Array.from(new Set(anchorToolCallIds || [])).filter(
      Boolean,
    ),
    messages: messages.map((message) => ({
      ...message,
      tool_calls: Array.isArray(message.tool_calls)
        ? message.tool_calls.map((toolCall) => ({
            ...toolCall,
            function: toolCall.function
              ? { ...toolCall.function }
              : toolCall.function,
          }))
        : message.tool_calls,
    })),
  });
  if (state.groups.length > _LOCAL_TOOL_TRANSCRIPT_GROUP_LIMIT) {
    state.groups.splice(
      0,
      state.groups.length - _LOCAL_TOOL_TRANSCRIPT_GROUP_LIMIT,
    );
  }
  state.updatedAt = now;
  _localToolTranscriptByConversation.delete(key);
  _localToolTranscriptByConversation.set(key, state);
  while (
    _localToolTranscriptByConversation.size > _CONVERSATION_AFFINITY_LIMIT
  ) {
    _localToolTranscriptByConversation.delete(
      _localToolTranscriptByConversation.keys().next().value,
    );
  }
}

function _injectLocalToolTranscript(key, messages) {
  if (!key || !Array.isArray(messages) || messages.length === 0)
    return messages;
  const state = _localToolTranscriptByConversation.get(key);
  if (!state) return messages;
  if (Date.now() - state.updatedAt > _CONVERSATION_AFFINITY_TTL_MS) {
    _localToolTranscriptByConversation.delete(key);
    return messages;
  }

  const output = messages.slice();
  const existingIds = _toolCallIds(output);
  let injectedGroups = 0;
  for (const group of state.groups) {
    if (group.callIds.some((id) => existingIds.has(id))) continue;
    let insertAt = -1;
    for (const anchorId of group.anchorToolCallIds) {
      insertAt = output.findIndex((message) =>
        ((message && message.tool_calls) || []).some(
          (toolCall) => toolCall && toolCall.id === anchorId,
        ),
      );
      if (insertAt >= 0) break;
    }
    if (insertAt < 0) {
      insertAt = output.length;
      for (let index = output.length - 1; index >= 0; index--) {
        const message = output[index];
        if (message && message.role === "user" && !message.tool_call_id) {
          insertAt = index;
          break;
        }
      }
    }
    const cloned = group.messages.map((message) => ({
      ...message,
      tool_calls: Array.isArray(message.tool_calls)
        ? message.tool_calls.map((toolCall) => ({
            ...toolCall,
            function: toolCall.function
              ? { ...toolCall.function }
              : toolCall.function,
          }))
        : message.tool_calls,
    }));
    output.splice(insertAt, 0, ...cloned);
    for (const id of group.callIds) existingIds.add(id);
    injectedGroups++;
  }
  if (injectedGroups > 0) {
    _routeDiag(
      `_localToolTranscript inject groups=${injectedGroups} key=${_cacheFingerprint(key)}`,
    );
  }
  state.updatedAt = Date.now();
  return output;
}

function _formatVisibleLocalGrepResult() {
  // Grep remains a model-visible tool result and is persisted across turns,
  // but its potentially large match body must not be duplicated into chat.
  return "";
}

function _cacheFingerprint(value) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value || null);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function _safeCorrelationHash(value) {
  const hash = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{8,64}$/.test(hash) ? hash : null;
}

// 多模态 content(array parts)抽稳定文本 · 首条 user 为图文混排时会话键不再为 null
function _messageContentSeedText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && part.text.trim()) {
      parts.push(part.text.trim());
    } else if (part.type && part.type !== "text") {
      // 非文本部件(图片/音频)以类型+指纹参与派生 · 保证同一首条消息键稳定
      parts.push(`[${part.type}:${_cacheFingerprint(part)}]`);
    }
  }
  return parts.join("\n");
}

function _conversationPromptCacheKey(parsed) {
  const cascadeId = parsed && parsed.cascadeId;
  if (cascadeId) return `dao:${cascadeId}`;
  const messages = (parsed && parsed.messages) || [];
  let seedText = "";
  const firstUser = messages.find((message) => {
    if (!message || message.role !== "user") return false;
    seedText = _messageContentSeedText(message.content);
    return !!seedText;
  });
  if (!firstUser) return null;
  const seed = `${(parsed && parsed.modelUid) || "model"}\n${seedText.slice(0, 8192)}`;
  return `dao:auto:${_cacheFingerprint(seed)}`;
}

function _usesProxyManagedExecution(target) {
  if (!target || typeof target !== "object") return false;
  const strategy = target.contextStrategy || {};
  return (
    target.proxyManagedExecution === true ||
    strategy.proxyManaged === true ||
    strategy.mode === "proxy-managed"
  );
}

function _usesPersistedToolOutputs(target, providerConfig, model, protocol) {
  if (!target || typeof target !== "object") return false;
  const strategy = target.contextStrategy || {};
  return strategy.persistToolOutputs === true;
}

function _circuitKey(providerName, model) {
  return `${providerName || ""}|${model || "*"}`;
}

function _parseRetryAfterMs(headers) {
  const raw = headers && headers["retry-after"];
  if (raw == null) return 0;
  const seconds = Number.parseInt(String(raw), 10);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function _upstreamFailurePolicy(status, body, headers) {
  const text = String(body || "").toLowerCase();
  const retryAfterMs = _parseRetryAfterMs(headers);
  if (status === 401) {
    return {
      open: true,
      providerWide: true,
      ttlMs: 15 * 60 * 1000,
      reason: "authentication",
    };
  }
  if (status === 403) {
    if (/insufficient|balance|余额|credit|quota|billing|payment/.test(text)) {
      return {
        open: true,
        providerWide: true,
        ttlMs: 30 * 60 * 1000,
        reason: "balance",
      };
    }
    return {
      open: true,
      providerWide: false,
      ttlMs: 10 * 60 * 1000,
      reason: "permission",
    };
  }
  if (status === 404) {
    return {
      open: true,
      providerWide: false,
      ttlMs: 10 * 60 * 1000,
      reason: "model_not_found",
    };
  }
  if (status === 408 || status === 425 || status === 429) {
    return {
      open: true,
      providerWide: false,
      ttlMs: Math.min(
        Math.max(retryAfterMs || 60 * 1000, 15 * 1000),
        10 * 60 * 1000,
      ),
      reason: status === 429 ? "rate_limit" : "transient",
    };
  }
  if (status >= 500) {
    return {
      open: true,
      providerWide: false,
      ttlMs: 30 * 1000,
      reason: "upstream_5xx",
    };
  }
  if (status === 0) {
    return {
      open: true,
      providerWide: false,
      ttlMs: 30 * 1000,
      reason: "network",
    };
  }
  return { open: false, providerWide: false, ttlMs: 0, reason: "" };
}

function _isHardCircuitFailure(policy) {
  return (
    policy.reason === "authentication" ||
    policy.reason === "balance" ||
    policy.reason === "permission" ||
    policy.reason === "model_not_found"
  );
}

function _shouldOpenCircuit(providerName, model, policy, status) {
  if (_isHardCircuitFailure(policy)) return { open: true, strikes: 1 };
  const key = _circuitKey(providerName, policy.providerWide ? "*" : model);
  const now = Date.now();
  const prior = _circuitStrikes.get(key);
  const withinWindow =
    prior && now - prior.lastAt <= _circuitPolicy.strikeWindowMs;
  const strikes = withinWindow ? prior.count + 1 : 1;
  _circuitStrikes.set(key, { count: strikes, lastAt: now, lastStatus: status });
  return { open: strikes >= _circuitPolicy.strikeThreshold, strikes };
}

function _openUpstreamCircuit(providerName, model, status, body, headers) {
  const policy = _upstreamFailurePolicy(status, body, headers);
  if (!policy.open) return null;
  const decision = _shouldOpenCircuit(providerName, model, policy, status);
  if (!decision.open) {
    _routeDiag(
      `[dao-router] [熔断降敏] ${providerName}/${model} ${policy.reason} strike=${decision.strikes}/${_circuitPolicy.strikeThreshold} · 暂不熔断`,
    );
    return null;
  }
  const circuitModel = policy.providerWide ? "*" : model;
  const circuit = {
    provider: providerName,
    model: circuitModel,
    status,
    reason: policy.reason,
    strikes: decision.strikes,
    until: Date.now() + policy.ttlMs,
  };
  _upstreamCircuits.set(_circuitKey(providerName, circuitModel), circuit);
  const parkedAffinities = _parkConversationAffinities(
    providerName,
    circuitModel,
  );
  if (_failureStats)
    _failureStats.record(providerName, model, {
      status,
      error: String(body || "").slice(0, 200),
    });
  _scheduleCircuitRecoveryProbe(providerName, circuitModel, policy.ttlMs);
  if (_alertCenter) {
    _alertCenter.push({
      level: "error",
      type: "circuit_open",
      title: `渠道熔断: ${providerName}`,
      detail: `${providerName}/${circuitModel} HTTP ${status} · ${policy.reason} · 拉黑 ${Math.round(policy.ttlMs / 1000)}s`,
      provider: providerName,
      model: circuitModel,
    });
  }
  return circuit;
}

// ★ 熔断自动探活回归: 拉黑期将满前主动探一次 · 活了立即恢复 (不被动等 TTL)
//   每个熔断键同时只挂一个探活定时器 · 失败则等 TTL 自然过期 (下次真请求再验)
const _circuitProbeTimers = new Map(); // circuitKey → Timeout
const _CIRCUIT_PROBE_MIN_TTL_MS = 10 * 1000; // TTL 太短不值得探 · 等自然过期

function _parkConversationAffinities(providerName, circuitModel) {
  if (!_circuitPolicy.restoreAffinity) return 0;
  const now = Date.now();
  let parked = 0;
  for (const [key, affinity] of Array.from(
    _conversationProviderAffinity.entries(),
  )) {
    const matches =
      affinity.provider === providerName &&
      (circuitModel === "*" || affinity.model === circuitModel);
    if (!matches || affinity.until <= now) continue;
    _conversationProviderAffinity.delete(key);
    _parkedConversationAffinity.set(key, {
      ...affinity,
      parkedFor: _circuitKey(providerName, circuitModel),
      parkedAt: now,
    });
    parked++;
  }
  return parked;
}

function _restoreConversationAffinities(providerName, circuitModel) {
  if (!_circuitPolicy.restoreAffinity) return 0;
  const now = Date.now();
  const parkedFor = _circuitKey(providerName, circuitModel);
  let restored = 0;
  for (const [key, affinity] of Array.from(
    _parkedConversationAffinity.entries(),
  )) {
    if (affinity.parkedFor !== parkedFor) continue;
    _parkedConversationAffinity.delete(key);
    if (affinity.until <= now) continue;
    const {
      parkedFor: _ignoredCircuit,
      parkedAt: _ignoredAt,
      ...original
    } = affinity;
    _touchConversationAffinity(key, original);
    restored++;
  }
  return restored;
}

function _scheduleCircuitRecoveryProbe(providerName, circuitModel, ttlMs) {
  if (!(ttlMs >= _CIRCUIT_PROBE_MIN_TTL_MS)) return;
  const key = _circuitKey(providerName, circuitModel);
  if (_circuitProbeTimers.has(key)) return;
  const early = Math.max(1000, Number(_circuitPolicy.earlyProbeMs) || 8000);
  const lead = Math.max(1000, Number(_circuitPolicy.probeLeadMs) || 5000);
  const interval = Math.max(
    2000,
    Number(_circuitPolicy.probeIntervalMs) || 5000,
  );
  const firstDelay = Math.max(1000, Math.min(early, ttlMs - lead));
  // ★ 周期探活: 首次 earlyProbeMs 后探 · 失败则每隔 probeIntervalMs 再探 · 活了立即恢复
  //   道义: 五十二章「天下有始，以為天下母」· 熔断有始 · 探活為母 · 母在則復 · 不棄一民
  const _probeOnce = async () => {
    _circuitProbeTimers.delete(key);
    try {
      const circuit = _upstreamCircuits.get(key);
      if (!circuit || circuit.until <= Date.now()) return; // 已自然过期
      const provCfg = _providers[providerName];
      if (!provCfg || provCfg.enabled === false) return;
      // ★ 用熔断的实际模型探活 · 不是 cfg.models[0] (可能是别的模型)
      const v = await _verifyProviderChat(providerName, provCfg, circuitModel);
      if (v && v.alive) {
        const restoredAffinities = _clearUpstreamCircuit(
          providerName,
          circuitModel,
        );
        _healthCache[providerName] = { alive: true, ts: Date.now() };
        _routeDiag(
          `[dao-router] [自愈] ${providerName}/${circuitModel} 探活成功 · 熔断提前解除 · 恢复会话=${restoredAffinities}`,
        );
        _log(
          `[dao-router] [自愈] ${providerName}/${circuitModel} 探活成功 · 熔断提前解除 · 恢复会话=${restoredAffinities}`,
        );
        if (_alertCenter)
          _alertCenter.push({
            level: "info",
            type: "circuit_recovered",
            title: `渠道恢复: ${providerName}`,
            detail: `${providerName}/${circuitModel} 探活成功 · 熔断提前解除 · 恢复会话=${restoredAffinities}`,
            provider: providerName,
            model: circuitModel,
          });
      } else {
        _routeDiag(
          `[dao-router] [自愈] ${providerName}/${circuitModel} 探活仍不通 (${(v && v.reason) || "?"}) · ${Math.round(interval / 1000)}s 后重探`,
        );
        if (_failureStats)
          _failureStats.record(providerName, circuitModel, {
            status: (v && v.status) || 0,
            error: `探活失败: ${(v && v.reason) || "不通"}`,
          });
        // ★ 周期重探: TTL 未过期则继续探 · 不被动等
        const remainingTtl = circuit.until - Date.now();
        if (remainingTtl > 2000) {
          const nextDelay = Math.min(interval, remainingTtl);
          const retryTimer = setTimeout(_probeOnce, nextDelay);
          if (retryTimer.unref) retryTimer.unref();
          _circuitProbeTimers.set(key, retryTimer);
        }
      }
    } catch {
      // 异常也重探 · 不因探活自身 bug 永久放弃
      const circuit = _upstreamCircuits.get(key);
      if (circuit) {
        const remainingTtl = circuit.until - Date.now();
        if (remainingTtl > 2000) {
          const nextDelay = Math.min(interval, remainingTtl);
          const retryTimer = setTimeout(_probeOnce, nextDelay);
          if (retryTimer.unref) retryTimer.unref();
          _circuitProbeTimers.set(key, retryTimer);
        }
      }
    }
  };
  const timer = setTimeout(_probeOnce, firstDelay);
  if (timer.unref) timer.unref();
  _circuitProbeTimers.set(key, timer);
}

function _getUpstreamCircuit(providerName, model) {
  const now = Date.now();
  for (const key of [
    _circuitKey(providerName, "*"),
    _circuitKey(providerName, model),
  ]) {
    const circuit = _upstreamCircuits.get(key);
    if (!circuit) continue;
    if (circuit.until <= now) {
      _clearUpstreamCircuit(providerName, circuit.model);
      continue;
    }
    return circuit;
  }
  return null;
}

function _clearUpstreamCircuit(providerName, model) {
  const modelKey = _circuitKey(providerName, model);
  const providerKey = _circuitKey(providerName, "*");
  _upstreamCircuits.delete(modelKey);
  _upstreamCircuits.delete(providerKey);
  _circuitStrikes.delete(modelKey);
  _circuitStrikes.delete(providerKey);
  for (const key of new Set([modelKey, providerKey])) {
    const timer = _circuitProbeTimers.get(key);
    if (timer) clearTimeout(timer);
    _circuitProbeTimers.delete(key);
  }
  let restored = _restoreConversationAffinities(providerName, model);
  if (model !== "*") {
    restored += _restoreConversationAffinities(providerName, "*");
  }
  return restored;
}

function _clearProviderRuntimeState(providerName) {
  for (const key of Array.from(_upstreamCircuits.keys())) {
    if (key.startsWith(`${providerName}|`)) _upstreamCircuits.delete(key);
  }
  for (const key of Array.from(_circuitStrikes.keys())) {
    if (key.startsWith(`${providerName}|`)) _circuitStrikes.delete(key);
  }
  for (const [key, timer] of Array.from(_circuitProbeTimers.entries())) {
    if (!key.startsWith(`${providerName}|`)) continue;
    clearTimeout(timer);
    _circuitProbeTimers.delete(key);
  }
  for (const [key, affinity] of Array.from(
    _conversationProviderAffinity.entries(),
  )) {
    if (affinity.provider === providerName)
      _conversationProviderAffinity.delete(key);
  }
  for (const [key, affinity] of Array.from(
    _parkedConversationAffinity.entries(),
  )) {
    if (affinity.provider === providerName)
      _parkedConversationAffinity.delete(key);
  }
  delete _healthCache[providerName];
}

function _providerSupportsModel(providerCfg, model) {
  if (!providerCfg || providerCfg.enabled === false || !model) return false;
  const models = Array.isArray(providerCfg.models) ? providerCfg.models : [];
  if (models.includes(model)) return true;
  return !!(
    providerCfg.modelCapabilities &&
    Object.prototype.hasOwnProperty.call(providerCfg.modelCapabilities, model)
  );
}

function _autoFallbackEnabled(target) {
  if (!target || target.autoFallback === false) return false;
  return _configuredChannelTargets(target).length > 1;
}

// ★ v9.9.430 · 同 provider 重试再切 (retry-before-failover)
//   道义: 七十六章「柔弱处上」· 柔弱者处上 · 弹性者处通
//   问题: 主路由循环遇到任何 HTTP 错误立即跳到下一个 provider → 一有波动就切换
//   解法: 对可重试的 transient/rate_limit/network 错误先退避重试当前 provider N 次,
//         真不行了再 failover。硬错误(401/余额/404/权限)直接切。
//   默认 2 次 (即总共尝试 3 次), 可通过 target.resilience.sameProviderRetries 覆盖。
function _sameProviderMaxRetries(target) {
  const raw =
    target && target.resilience && target.resilience.sameProviderRetries;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && raw != null
    ? Math.min(n, 5)
    : _sameProviderMaxRetriesDefault;
}

const _sameProviderMaxRetriesDefault = 2;

// 硬故障: 重试无意义, 应立即 failover
const _HARD_FAILURE_REASONS = new Set([
  "authentication",
  "balance",
  "permission",
  "model_not_found",
]);

function _isHardFailure(status) {
  const policy = _upstreamFailurePolicy(status, "", null);
  return _HARD_FAILURE_REASONS.has(policy.reason);
}

function _channelStrategy(target) {
  return target && target.channelStrategy === "random" ? "random" : "priority";
}

function _configuredChannelTargets(target) {
  if (!target || typeof target !== "object") return [];
  const result = [];
  const byKey = new Map();
  const seen = new Set();
  const add = (entry) => {
    const provider = String((entry && entry.provider) || "").trim();
    const model = String(
      (entry && (entry.model || entry.upstreamModel)) || "",
    ).trim();
    if (!provider || !model) return;
    const key = `${provider}|${model}`;
    const normalized = { provider, model };
    [
      "protocol",
      "sourceProtocol",
      "reasoningLevel",
      "reasoningEffort",
      "thinkingEnabled",
      "thinkingBudget",
    ].forEach((field) => {
      if (
        entry &&
        Object.prototype.hasOwnProperty.call(entry, field) &&
        entry[field] !== undefined
      )
        normalized[field] = entry[field];
    });
    if (seen.has(key)) {
      const existing = byKey.get(key);
      Object.keys(normalized).forEach((field) => {
        if (
          field !== "provider" &&
          field !== "model" &&
          existing[field] === undefined
        )
          existing[field] = normalized[field];
      });
      return;
    }
    seen.add(key);
    byKey.set(key, normalized);
    result.push(normalized);
  };
  if (Array.isArray(target.channelPriority)) {
    target.channelPriority.forEach(add);
  }
  add(target);
  if (target.fallback) add(target.fallback);
  return result;
}

function _orderedConfiguredChannelTargets(target, randomFn) {
  const channels = _configuredChannelTargets(target);
  if (_channelStrategy(target) !== "random" || channels.length < 2) {
    return channels;
  }
  const random = typeof randomFn === "function" ? randomFn : Math.random;
  const shuffled = channels.slice();
  for (let index = shuffled.length - 1; index > 0; index--) {
    const offset = Math.max(
      0,
      Math.min(index, Math.floor(Number(random()) * (index + 1))),
    );
    [shuffled[index], shuffled[offset]] = [shuffled[offset], shuffled[index]];
  }
  return shuffled;
}

function _conversationAffinityKey(target, callOpts) {
  const promptCacheKey = callOpts && callOpts._promptCacheKey;
  const routeIdentity =
    target && (target._customModel || target._customModelId)
      ? `custom:${target._customModelId || target.model}:${_configuredChannelTargets(
          target,
        )
          .map((entry) => `${entry.provider}/${entry.model}`)
          .join(",")}`
      : target &&
        `route:${target._routeUid || `${target.provider}/${target.model}`}:${_configuredChannelTargets(
          target,
        )
          .map((entry) => `${entry.provider}/${entry.model}`)
          .join(
            ",",
          )}:${target.reasoningLevel || target.reasoningEffort || "default"}`;
  return promptCacheKey && routeIdentity
    ? `${routeIdentity}|${promptCacheKey}`
    : null;
}

function _touchConversationAffinity(key, value) {
  _conversationProviderAffinity.delete(key);
  _conversationProviderAffinity.set(key, value);
  while (_conversationProviderAffinity.size > _CONVERSATION_AFFINITY_LIMIT) {
    _conversationProviderAffinity.delete(
      _conversationProviderAffinity.keys().next().value,
    );
  }
}

function _rememberConversationProvider(target, callOpts, selectedTarget) {
  const key = _conversationAffinityKey(target, callOpts);
  if (
    !key ||
    !selectedTarget ||
    (_channelStrategy(target) !== "random" &&
      selectedTarget.provider === target.provider &&
      selectedTarget.model === target.model)
  )
    return;
  // ★ 抗抖动: 当前亲和渠道未被熔断时不因备选渠道偶然成功就切换 (避免乒乓)
  const _existingAffinity = _conversationProviderAffinity.get(key);
  if (
    _existingAffinity &&
    _existingAffinity.until > Date.now() &&
    _existingAffinity.provider !== selectedTarget.provider &&
    !_getUpstreamCircuit(_existingAffinity.provider, _existingAffinity.model)
  ) {
    return;
  }
  _touchConversationAffinity(key, {
    provider: selectedTarget.provider,
    model: selectedTarget.model,
    protocol: selectedTarget.protocol,
    sourceProtocol: selectedTarget.sourceProtocol,
    reasoningLevel: selectedTarget.reasoningLevel,
    reasoningEffort: selectedTarget.reasoningEffort,
    thinkingEnabled: selectedTarget.thinkingEnabled,
    thinkingBudget: selectedTarget.thinkingBudget,
    until: Date.now() + _CONVERSATION_AFFINITY_TTL_MS,
  });
}

function _forgetConversationProvider(target, callOpts) {
  const key = _conversationAffinityKey(target, callOpts);
  if (key) _conversationProviderAffinity.delete(key);
}

function _stickyConversationTarget(target, callOpts) {
  const key = _conversationAffinityKey(target, callOpts);
  if (!key) return null;
  const affinity = _conversationProviderAffinity.get(key);
  if (!affinity) return null;
  const configuredFallback = _configuredChannelTargets(target).some(
    (entry) =>
      entry.provider === affinity.provider && entry.model === affinity.model,
  );
  if (!_autoFallbackEnabled(target) && !configuredFallback) {
    _conversationProviderAffinity.delete(key);
    return null;
  }
  if (affinity.until <= Date.now()) {
    _conversationProviderAffinity.delete(key);
    return null;
  }
  const providerCfg = _providers[affinity.provider];
  if (
    !_providerSupportsModel(providerCfg, affinity.model) ||
    _getUpstreamCircuit(affinity.provider, affinity.model)
  ) {
    _conversationProviderAffinity.delete(key);
    return null;
  }
  _touchConversationAffinity(key, affinity);
  return {
    ...target,
    ...affinity,
    provider: affinity.provider,
    model: affinity.model,
    _autoFallback: true,
  };
}

function _autoFallbackTargets(target, callOpts, excludedProviders) {
  if (!_autoFallbackEnabled(target)) return [];
  const excluded = excludedProviders || new Set();
  return _orderedConfiguredChannelTargets(target)
    .filter(
      (entry) =>
        !(entry.provider === target.provider && entry.model === target.model) &&
        !excluded.has(entry.provider) &&
        _providerSupportsModel(_providers[entry.provider], entry.model) &&
        !_getUpstreamCircuit(entry.provider, entry.model),
    )
    .map((entry) => ({
      ...target,
      ...entry,
      provider: entry.provider,
      model: entry.model,
      _autoFallback: true,
    }));
}

function _buildDispatchCandidates(target, callOpts) {
  const candidates = [];
  const candidateKeys = new Set();
  const addCandidate = (candidate, source) => {
    if (!candidate || !candidate.provider || !candidate.model) return;
    const key = `${candidate.provider}|${candidate.model}`;
    if (candidateKeys.has(key)) return;
    candidateKeys.add(key);
    candidates.push({ target: candidate, source });
  };

  // Priority routing remains the configured order. Conversation affinity is
  // only a legacy random-mode aid and must not silently move a priority route.
  if (_channelStrategy(target) === "random") {
    addCandidate(_stickyConversationTarget(target, callOpts), "sticky");
  }
  if (_channelStrategy(target) === "random" && _autoFallbackEnabled(target)) {
    _orderedConfiguredChannelTargets(target).forEach((entry, index) => {
      addCandidate(
        {
          ...target,
          ...entry,
          provider: entry.provider,
          model: entry.model,
          _autoFallback: index > 0,
        },
        index === 0 ? "random-primary" : "random-fallback",
      );
    });
  } else {
    // Priority 模式默认严守配置顺序。折中(缓存友好): 仅当主渠道熔断【未恢复】时,
    // 若存在健康的会话粘性备用渠道, 把它插到主渠道之前 —— 主渠道故障窗口内复用
    // 该备用渠道上已热的前缀缓存, 避免每轮在主渠道冷启动。主渠道熔断一旦恢复
    // (circuit 清除)即不再前插, 立刻回到 priority 原序 —— 不改变常态语义。
    if (_getUpstreamCircuit(target.provider, target.model)) {
      addCandidate(_stickyConversationTarget(target, callOpts), "sticky-circuit");
    }
    addCandidate(target, "primary");
    if (target.fallback && target.fallback.provider) {
      addCandidate(
        {
          ...target,
          ...target.fallback,
          maxOutputTokens: target.maxOutputTokens,
        },
        "configured-fallback",
      );
    }
    for (const autoTarget of _autoFallbackTargets(
      target,
      callOpts,
      new Set(),
    )) {
      addCandidate(autoTarget, "auto-fallback");
    }
  }
  return candidates;
}

function _promptCacheProviderId(providerName, provCfg) {
  return `${providerName || ""}|${(provCfg && provCfg.baseUrl) || ""}`;
}

function _resolvePromptCacheKey(
  provCfg,
  target,
  providerName,
  model,
  callOpts,
) {
  if (!callOpts || callOpts._disablePromptCacheKey) return null;
  if (
    _promptCacheKeyUnsupported.has(
      _promptCacheProviderId(providerName, provCfg),
    )
  )
    return null;

  const routeSetting =
    target && Object.prototype.hasOwnProperty.call(target, "promptCacheKey")
      ? target.promptCacheKey
      : undefined;
  const setting =
    routeSetting !== undefined
      ? routeSetting
      : provCfg && provCfg.promptCacheKey;
  if (setting === false) return null;
  if (typeof setting === "string" && setting.trim())
    return setting.trim().slice(0, 256);

  const autoEnabled =
    setting === true ||
    (!!provCfg &&
      provCfg.type === "openai-compatible" &&
      /^(?:gpt-5|o3(?:-|$)|o4(?:-|$))/i.test(model || ""));
  if (!autoEnabled || !callOpts._promptCacheKey) return null;
  return String(callOpts._promptCacheKey).slice(0, 256);
}

function _promptCacheSettings(provCfg, target) {
  const providerSettings =
    provCfg && provCfg.promptCache && typeof provCfg.promptCache === "object"
      ? provCfg.promptCache
      : {};
  const routeSettings =
    target && target.promptCache && typeof target.promptCache === "object"
      ? target.promptCache
      : {};
  return {
    ...providerSettings,
    ...routeSettings,
    warmup: {
      ...(providerSettings.warmup && typeof providerSettings.warmup === "object"
        ? providerSettings.warmup
        : {}),
      ...(routeSettings.warmup && typeof routeSettings.warmup === "object"
        ? routeSettings.warmup
        : {}),
    },
  };
}

function _decoratePromptCacheBody(
  body,
  provCfg,
  target,
  providerName,
  model,
  protocol,
  promptCacheKey,
  callOpts,
) {
  // policy 未加载: 也要剥净适配器可能已钉的裸断点 (含易变末条), 避免无谓 cache-write。
  if (!_promptCachePolicy) return _stripCacheAnnotationsSafe(body);
  try {
    const plan = _promptCachePolicy.plan({
      providerId: _promptCacheProviderId(providerName, provCfg),
      protocol,
      model,
      sessionKey: promptCacheKey,
      settings: _promptCacheSettings(provCfg, target),
    });
    const decorated = _promptCachePolicy.decorate(body, plan);
    if (callOpts) {
      callOpts._promptCachePlan = plan;
      callOpts._cacheObservation = {
        ...(callOpts._cacheObservation || {}),
        ...(decorated.diagnostics || {}),
      };
      callOpts._cacheWarmupCandidate = decorated.warmupSnapshot
        ? {
            plan,
            // 优先 policy 的 CJK 感知估算; 旧 diagnostics 无此字段时退回 chars/4
            stableTokens:
              Number(
                decorated.diagnostics &&
                  decorated.diagnostics.stablePrefixTokens,
              ) ||
              Math.ceil(
                Number(
                  (decorated.diagnostics &&
                    decorated.diagnostics.stablePrefixChars) ||
                    0,
                ) / 4,
              ),
            snapshot: {
              providerName,
              model,
              protocol,
              body: decorated.warmupSnapshot,
            },
          }
        : null;
    }
    return decorated.body;
  } catch (error) {
    _routeDiag(
      `_callProvider cache policy bypass provider=${providerName} reason=${String(error.message || "error").slice(0, 120)}`,
    );
    // decorate 异常 bypass: 同样剥净裸断点, 不把易变末条当缓存前缀送出。
    return _stripCacheAnnotationsSafe(body);
  }
}

// 尽力剥净缓存标注: 优先用 policy 实例的方法, 退回模块级导出, 再退回原样。
function _stripCacheAnnotationsSafe(body) {
  try {
    if (_promptCachePolicy && typeof _promptCachePolicy.stripCacheAnnotations === "function") {
      return _promptCachePolicy.stripCacheAnnotations(body);
    }
    if (
      _promptCachePolicyModule &&
      typeof _promptCachePolicyModule.stripCacheAnnotations === "function"
    ) {
      return _promptCachePolicyModule.stripCacheAnnotations(body);
    }
  } catch (_) {}
  return body;
}

async function _sendPromptCacheWarmup(snapshot) {
  if (!snapshot || !snapshot.providerName || !snapshot.body) {
    throw new Error("invalid warmup snapshot");
  }
  const providerName = snapshot.providerName;
  const provCfg = _providers[providerName];
  if (!provCfg || provCfg.enabled === false) {
    throw new Error("warmup provider unavailable");
  }
  const protocol = snapshot.protocol || "openai-chat";
  const adapter = _adapters && _adapters.adapterFor(protocol);
  if (!adapter) throw new Error("warmup protocol unavailable");
  const bodyObj = JSON.parse(JSON.stringify(snapshot.body));
  bodyObj.stream = false;
  delete bodyObj.stream_options;
  if (protocol === "openai-responses") {
    bodyObj.max_output_tokens = 1;
  } else {
    bodyObj.max_tokens = 1;
  }
  if (Array.isArray(bodyObj.tools) && bodyObj.tools.length > 0) {
    bodyObj.tool_choice = protocol === "anthropic" ? { type: "none" } : "none";
  } else {
    delete bodyObj.tool_choice;
  }

  const completionPath = adapter.getCompletionPath(
    provCfg,
    snapshot.model,
    false,
  );
  const targetUrl = provCfg.baseUrl
    ? new URL(_joinCompletionUrl(provCfg.baseUrl, completionPath))
    : new URL(_gatewayUrl + completionPath);
  const adapterOptions = adapter.buildRequestOpts(provCfg, bodyObj, targetUrl);
  const body = JSON.stringify(bodyObj);
  const isHttps = targetUrl.protocol === "https:";
  const transport = isHttps ? https : http;
  const agent = _getAffinityAgent(
    isHttps,
    targetUrl,
    providerName,
    bodyObj.prompt_cache_key || null,
  );

  await new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: targetUrl.hostname,
        port: parseInt(targetUrl.port || (isHttps ? "443" : "80")),
        path: targetUrl.pathname + (targetUrl.search || ""),
        method: "POST",
        headers: {
          ...((adapterOptions && adapterOptions.headers) || {}),
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        rejectUnauthorized: _tlsRejectUnauthorized(),
        agent,
      },
      (response) => {
        response.on("data", () => {});
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300)
            resolve();
          else reject(new Error(`warmup HTTP ${response.statusCode || 0}`));
        });
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("warmup timeout")));
    req.write(body);
    req.end();
  });
}

function _responsesContinuationKey(providerName, model, promptCacheKey) {
  if (!promptCacheKey) return null;
  return `${providerName || "provider"}|${model || "model"}|${promptCacheKey}`;
}

function _requestReasoningSettings(target, protocol, model, hasTools) {
  const selectedLevel = String((target && target.reasoningLevel) || "")
    .trim()
    .toLowerCase();
  const settings = {
    thinkingEnabled: !!(target && target.thinkingEnabled),
    thinkingBudget: target && target.thinkingBudget,
    reasoningEffort: target && target.reasoningEffort,
    adjusted: false,
  };
  // A route-level reasoning selection is authoritative. Older route records
  // often retained thinkingEnabled=false after the UI had saved high/medium.
  if (selectedLevel && selectedLevel !== "off" && selectedLevel !== "none") {
    settings.reasoningEffort =
      selectedLevel === "auto" ||
      selectedLevel === "max" ||
      selectedLevel === "xhigh"
        ? "high"
        : selectedLevel;
    settings.thinkingEnabled = true;
    settings.thinkingBudget = null;
  } else if (selectedLevel === "off" || selectedLevel === "none") {
    settings.thinkingEnabled = false;
    settings.thinkingBudget = null;
    settings.reasoningEffort = null;
  } else if (protocol === "openai-responses" && settings.reasoningEffort) {
    settings.thinkingEnabled = true;
  }
  // GPT-5.6 reasoning alongside function tools was assumed to be a Responses-only
  // contract, so reasoning was stripped up front on the Chat endpoint. Measured
  // against the configured upstream that assumption is wrong: chat + tools +
  // reasoning_effort=high answers 200 with reasoning_tokens > 0, while the same
  // request on /responses came back with reasoning_tokens=0. Stripping therefore
  // removed the very thinking the route asked for. An explicit route-level
  // selection now wins; a route that never picked a level keeps the conservative
  // strip, and if some upstream really does reject the field the transparent
  // retry (_isReasoningParamUnsupportedResponse) drops it without failing.
  if (
    target &&
    target._customModel &&
    protocol === "openai-chat" &&
    hasTools &&
    !selectedLevel &&
    /gpt[-_.]?5(?:[-_.]?6|\.6)/i.test(String(model || ""))
  ) {
    settings.thinkingEnabled = false;
    settings.thinkingBudget = null;
    settings.reasoningEffort = "none";
    settings.adjusted = true;
  }
  return settings;
}

function _isGpt56Sol(model) {
  return /^gpt[-_.]?5[-_.]?6[-_.]?sol$/i.test(String(model || "").trim());
}

function _reasoningLevelFromRouteIdentity(modelUid, target) {
  const explicit = String((target && target.reasoningLevel) || "")
    .trim()
    .toLowerCase();
  if (explicit) return explicit;
  const identity = `${modelUid || ""} ${(target && target._label) || ""}`;
  if (/(?:^|[-_.\s])(xhigh|max)(?:$|[-_.\s])/i.test(identity)) return "high";
  if (/(?:^|[-_.\s])(high|thinking)(?:$|[-_.\s])/i.test(identity))
    return "high";
  if (/(?:^|[-_.\s])(medium|med)(?:$|[-_.\s])/i.test(identity)) return "medium";
  if (/(?:^|[-_.\s])low(?:$|[-_.\s])/i.test(identity)) return "low";
  return "";
}

function _isQualityRoute(modelUid, target) {
  const level = _reasoningLevelFromRouteIdentity(modelUid, target);
  if (level && level !== "off" && level !== "none") return true;
  if (target && target.reasoningEffort) return true;
  const identity = `${modelUid || ""} ${(target && target._label) || ""}`;
  return /(?:^|[-_.\s])(thinking|reasoning|quality|opus|high|xhigh)(?:$|[-_.\s])/i.test(
    identity,
  );
}

// Determine chat-only intent from the route's own channel declarations, since
// _providers is not yet populated when init() normalizes routes. If every
// configured channel explicitly speaks openai-chat (or the route's own
// protocol/sourceProtocol is chat), the upstream has no /responses endpoint and
// must not be force-upgraded. 名实相符 · 不强其所不能。
function _routeChannelsChatOnly(routeCfg) {
  const chan = Array.isArray(routeCfg && routeCfg.channelPriority)
    ? routeCfg.channelPriority
    : [];
  if (chan.length > 0) {
    return chan.every((c) => {
      const p = _endpointProtocol(c && (c.protocol || c.sourceProtocol));
      return p === "openai-chat";
    });
  }
  const own = _endpointProtocol(
    routeCfg && (routeCfg.protocol || routeCfg.sourceProtocol),
  );
  return own === "openai-chat";
}

function _normalizeQualityRoute(modelUid, routeCfg) {
  if (!routeCfg || typeof routeCfg !== "object") return routeCfg;
  if (!_isGpt56Sol(routeCfg.model) || !_isQualityRoute(modelUid, routeCfg)) {
    return routeCfg;
  }
  // Chat-only upstreams (e.g. ay/kfcsol/soll sub2api relays) have no /responses
  // endpoint; forcing responses yields 404 / empty-stream 502. Respect the
  // route's explicit chat declaration instead of overriding it.
  if (_routeChannelsChatOnly(routeCfg)) {
    return routeCfg;
  }

  // GPT-5.6 reasoning plus function tools is a Responses contract. Keep the
  // provider's default protocol for other models, but make this route explicit
  // so runtime fallback and persisted routes cannot silently return to Chat.
  routeCfg.protocol = "openai-responses";
  routeCfg.sourceProtocol = "openai-responses";

  const level = _reasoningLevelFromRouteIdentity(modelUid, routeCfg);
  if (level && level !== "off" && level !== "none") {
    if (!routeCfg.reasoningLevel) routeCfg.reasoningLevel = level;
    routeCfg.reasoningEffort =
      level === "auto" || level === "max" || level === "xhigh" ? "high" : level;
    routeCfg.thinkingEnabled = true;
    routeCfg.thinkingBudget = null;
  }
  return routeCfg;
}

function _completionPathProtocol(value) {
  const path = String(value || "")
    .toLowerCase()
    .split(/[?#]/, 1)[0];
  if (!path) return "";
  if (/\/(?:v\d+\/)?responses\/?$/.test(path)) return "openai-responses";
  if (/\/(?:v\d+\/)?chat\/completions\/?$/.test(path)) return "openai-chat";
  if (/\/(?:v\d+\/)?messages\/?$/.test(path)) return "anthropic";
  if (/(?:^|[:/])(?:stream)?generatecontent\/?$/.test(path)) return "gemini";
  return "";
}

function _resolveTargetProtocolDecision(target, providerConfig, model) {
  target = target && typeof target === "object" ? target : {};
  providerConfig =
    providerConfig && typeof providerConfig === "object" ? providerConfig : {};
  const channelExplicit = _endpointProtocol(
    target.protocol || target.upstreamProtocol,
  );
  const routeExplicit = _endpointProtocol(target.sourceProtocol);
  const configuredProtocol = channelExplicit || routeExplicit || "";
  const providerExplicit = _endpointProtocol(
    providerConfig.protocol || providerConfig.type,
  );
  const advertised = Array.isArray(providerConfig.supportedProtocols)
    ? providerConfig.supportedProtocols.map(_endpointProtocol).filter(Boolean)
    : [];
  const uniqueAdvertised = [...new Set(advertised)];
  const chatOnly =
    uniqueAdvertised.length > 0 &&
    uniqueAdvertised.every((protocol) => protocol === "openai-chat");

  const decision = (protocol, source, adjusted = false, reason = "") => ({
    protocol,
    configuredProtocol,
    source,
    adjusted,
    reason,
  });

  if (
    channelExplicit &&
    (!uniqueAdvertised.length || uniqueAdvertised.includes(channelExplicit))
  ) {
    return decision(channelExplicit, "channel-config");
  }
  if (
    routeExplicit &&
    (!uniqueAdvertised.length || uniqueAdvertised.includes(routeExplicit))
  ) {
    return decision(routeExplicit, "route-config");
  }

  // A non-empty capability list is a hard boundary. Configured protocols can
  // explain intent, but must not force a provider endpoint it says it cannot
  // serve. This changes only the transport protocol; candidate order and the
  // selected provider/model remain untouched.
  if (uniqueAdvertised.length) {
    let compatible = "";
    const completionProtocol = _completionPathProtocol(
      providerConfig.completionPath,
    );
    if (completionProtocol && uniqueAdvertised.includes(completionProtocol)) {
      compatible = completionProtocol;
    } else if (
      _isGpt56Sol(model) &&
      _isQualityRoute(null, target) &&
      uniqueAdvertised.includes("openai-responses")
    ) {
      compatible = "openai-responses";
    } else if (
      String(providerConfig.type || "").toLowerCase() === "openai-compatible" &&
      uniqueAdvertised.includes("openai-chat")
    ) {
      compatible = "openai-chat";
    } else if (
      providerExplicit &&
      uniqueAdvertised.includes(providerExplicit)
    ) {
      compatible = providerExplicit;
    } else {
      const detected = _adapters
        ? _endpointProtocol(_adapters.detectProtocol(providerConfig, model))
        : "";
      compatible =
        detected && uniqueAdvertised.includes(detected)
          ? detected
          : uniqueAdvertised[0];
    }
    return decision(
      compatible,
      "provider-capability",
      Boolean(configuredProtocol && compatible !== configuredProtocol),
      configuredProtocol && compatible !== configuredProtocol
        ? "configured-protocol-unsupported"
        : "",
    );
  }

  if (channelExplicit) return decision(channelExplicit, "channel-config");
  if (routeExplicit) return decision(routeExplicit, "route-config");
  if (_isGpt56Sol(model) && _isQualityRoute(null, target) && !chatOnly) {
    return decision("openai-responses", "model-detection");
  }
  if (providerExplicit === "openai-chat" || chatOnly) {
    return decision("openai-chat", "provider-config");
  }
  const detected = _adapters
    ? _endpointProtocol(_adapters.detectProtocol(providerConfig, model)) ||
      "openai-chat"
    : "openai-chat";
  return decision(detected, "model-detection");
}

function _resolveTargetProtocol(target, providerConfig, model) {
  return _resolveTargetProtocolDecision(target, providerConfig, model).protocol;
}

function _isReasoningParamUnsupportedResponse(status, body) {
  return (
    (status === 400 || status === 422) &&
    /reasoning[_ .-]?effort|thinking/i.test(String(body || "")) &&
    /unsupported|not supported|unknown|invalid|unrecognized|不支持|无效/i.test(
      String(body || ""),
    )
  );
}

function _isEncryptedReasoningUnsupportedResponse(status, body) {
  const text = String(body || "");
  return (
    (status === 400 || status === 422) &&
    /reasoning\.encrypted_content|encrypted[_ .-]?content/i.test(text) &&
    /unsupported|not supported|unknown|invalid|unrecognized|include/i.test(text)
  );
}

function _isPromptCacheKeyUnsupportedResponse(status, body) {
  return (
    (status === 400 || status === 422) &&
    /prompt[_ -]?cache[_ -]?key/i.test(String(body || ""))
  );
}

function _observedDuration(value) {
  if (value == null || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function _safeAttemptSummary(attempt) {
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt))
    return null;
  const outcome = ["committed", "failed", "discarded"].includes(attempt.outcome)
    ? attempt.outcome
    : "discarded";
  const numberOrNull = (value, min = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min ? parsed : null;
  };
  const status = Number(attempt.status);
  return {
    attemptIndex: Math.max(1, Math.floor(Number(attempt.attemptIndex) || 1)),
    provider: String(attempt.provider || "").slice(0, 100),
    model: String(attempt.model || "").slice(0, 100),
    startedAt: numberOrNull(attempt.startedAt) || 0,
    endedAt: numberOrNull(attempt.endedAt),
    durationMs: numberOrNull(attempt.durationMs),
    status:
      Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    outcome,
    errorCategory: String(attempt.errorCategory || "").slice(0, 40),
    retryReason: String(attempt.retryReason || "").slice(0, 80),
    usageObserved: attempt.usageObserved === true,
    input: numberOrNull(attempt.input) || 0,
    output: numberOrNull(attempt.output) || 0,
    cached: numberOrNull(attempt.cached) || 0,
    cacheWrite: numberOrNull(attempt.cacheWrite) || 0,
  };
}

function _recordUsage(providerName, model, tc, observation) {
  if (!providerName) return;
  const inTok = (tc && tc.input) || 0;
  const outTok = (tc && tc.output) || 0;
  const cachedTok = (tc && tc.cached) || 0;
  const cacheWriteTok = (tc && tc.cacheWrite) || 0;
  let p = _usage[providerName];
  if (!p) {
    p = _usage[providerName] = {
      input: 0,
      output: 0,
      cached: 0,
      cacheWrite: 0,
      cacheInput: 0,
      calls: 0,
      since: Date.now(),
      models: {},
    };
  }
  const _sampleProtocol = (observation && observation.protocol) || null;
  const _sampleCacheInput = _cacheInputDenominator(
    inTok,
    cachedTok,
    cacheWriteTok,
    _sampleProtocol,
  );
  p.input += inTok;
  p.output += outTok;
  p.cached = (p.cached || 0) + cachedTok;
  p.cacheWrite = (p.cacheWrite || 0) + cacheWriteTok;
  p.cacheInput = (p.cacheInput || 0) + _sampleCacheInput;
  p.calls += 1;
  const mk = model || "?";
  let m = p.models[mk];
  if (!m) {
    m = p.models[mk] = {
      input: 0,
      output: 0,
      cached: 0,
      cacheWrite: 0,
      cacheInput: 0,
      calls: 0,
    };
  }
  m.input += inTok;
  m.output += outTok;
  m.cached = (m.cached || 0) + cachedTok;
  m.cacheWrite = (m.cacheWrite || 0) + cacheWriteTok;
  m.cacheInput = (m.cacheInput || 0) + _sampleCacheInput;
  m.calls += 1;

  const sample = {
    at: Date.now(),
    provider: providerName,
    model: model || "?",
    source: (observation && observation.source) || "external",
    input: inTok,
    output: outTok,
    cached: cachedTok,
    cacheWrite: cacheWriteTok,
    protocol: _sampleProtocol,
    cacheInput: _sampleCacheInput,
    hitRate: _hitRateForDenominator(cachedTok, _sampleCacheInput),
    cacheKeyHash: _safeCorrelationHash(observation && observation.cacheKeyHash),
    sessionHash: _safeCorrelationHash(observation && observation.sessionHash),
    agentSessionHash: _safeCorrelationHash(
      observation && observation.agentSessionHash,
    ),
    systemHash: (observation && observation.systemHash) || null,
    toolsHash: (observation && observation.toolsHash) || null,
    // 判读「上游改前缀」vs「断点划错」: systemToolsHash 不变而 stablePrefixHash 变 → 断点问题
    systemToolsHash: (observation && observation.systemToolsHash) || null,
    messagesHash: (observation && observation.messagesHash) || null,
    messageCount: (observation && observation.messageCount) || 0,
    toolCount: (observation && observation.toolCount) || 0,
    stopReason:
      observation && observation.stopReason !== undefined
        ? observation.stopReason
        : null,
    responseToolCount: (observation && observation.responseToolCount) || 0,
    textBytes: (observation && observation.textBytes) || 0,
    cacheMode: (observation && observation.cacheMode) || "off",
    cacheTtl: (observation && observation.cacheTtl) || null,
    breakpointCount: (observation && observation.breakpointCount) || 0,
    cacheFamilyHash: _safeCorrelationHash(
      observation && observation.cacheFamilyHash,
    ),
    stablePrefixHash: (observation && observation.stablePrefixHash) || null,
    stablePrefixChars: (observation && observation.stablePrefixChars) || 0,
    stableMessageCount:
      Math.max(0, Number(observation && observation.stableMessageCount) || 0),
    stableItemHashes: (Array.isArray(observation && observation.stableItemHashes)
      ? observation.stableItemHashes
      : [])
      .filter((value) => /^[a-f0-9]{12}$/i.test(String(value || "")))
      .slice(-256),
    volatileSuffixCount: (observation && observation.volatileSuffixCount) || 0,
    cacheDowngrade: (observation && observation.cacheDowngrade) || null,
    warmup: observation && observation.warmup === true,
    ttftMs: _observedDuration(observation && observation.ttftMs),
    ttftObserved: observation && observation.ttftObserved === true,
    daoDispatchMs: _observedDuration(observation && observation.daoDispatchMs),
    upstreamHeaderMs: _observedDuration(
      observation && observation.upstreamHeaderMs,
    ),
    upstreamSemanticMs: _observedDuration(
      observation && observation.upstreamSemanticMs,
    ),
    retryOverheadMs: _observedDuration(
      observation && observation.retryOverheadMs,
    ),
    durationMs: _observedDuration(observation && observation.durationMs),
    attemptCount: Math.max(
      1,
      Number(observation && observation.attemptCount) || 1,
    ),
    committedAttempt:
      Math.max(
        0,
        Math.floor(
          Number(observation && observation.committedAttemptIndex) || 0,
        ),
      ) || null,
    attempts: (Array.isArray(observation && observation.attempts)
      ? observation.attempts
      : []
    )
      .slice(-8)
      .map(_safeAttemptSummary)
      .filter(Boolean),
    reasoningEffort: String(
      (observation && observation.reasoningEffort) || "",
    ).slice(0, 20),
    firstSignalKind:
      observation &&
      (observation.firstSignalKind === "text" ||
        observation.firstSignalKind === "tool")
        ? observation.firstSignalKind
        : "none",
    success: !(observation && observation.success === false),
    usageObserved:
      (tc && tc.usageObserved === true) ||
      (observation && observation.usageObserved === true),
    errorCategory: String(
      (observation && observation.errorCategory) || "",
    ).slice(0, 40),
  };
  _cacheSamples.push(sample);
  _retainBoundedSamples(_cacheSamples);
  _requestHistorySamples.push(sample);
  _retainBoundedSamples(_requestHistorySamples);
  _scheduleRequestHistoryWrite();
  // ★ 预算超限主动告警: 渠道配了 pricing.budgetLimit (累计花费上限) 时生效
  if (_alertCenter) {
    const provCfg = _providers[providerName] || {};
    const limit = Number(provCfg.pricing && provCfg.pricing.budgetLimit);
    if (limit > 0) {
      const cost = _estCost(provCfg, p.input, p.output);
      if (cost != null && cost >= limit) {
        _alertCenter.push({
          level: "warn",
          type: "budget_exceeded",
          title: `渠道 ${providerName} 花费超预算`,
          detail: `累计估算花费 ${cost} ≥ 预算 ${limit} ${(provCfg.pricing && provCfg.pricing.currency) || "USD"}`,
          provider: providerName,
        });
      }
    }
  }
  _routeDiag(
    `_cacheUsage provider=${providerName} model=${sample.model} input=${inTok} cached=${cachedTok} write=${cacheWriteTok} hitRate=${sample.hitRate}% mode=${sample.cacheMode} ttl=${sample.cacheTtl || "none"} breakpoints=${sample.breakpointCount} volatile=${sample.volatileSuffixCount} downgrade=${sample.cacheDowngrade || "none"} key=${sample.cacheKeyHash || "none"} sys=${sample.systemHash || "none"} tools=${sample.toolsHash || "none"} msgs=${sample.messagesHash || "none"} stop=${sample.stopReason === null ? "none" : sample.stopReason} responseTools=${sample.responseToolCount}`,
  );
}
// 缓存命中率(%) = cached / 总 prompt token
//   OpenAI/DeepSeek: prompt_tokens 已含缓存部分 → 分母=input
//   Anthropic: input_tokens 不含缓存读/写部分 → 分母=input+cached+cacheWrite
//   协议已知时精确分支; 未知(外部样本/旧数据)退回启发式 —
//   旧启发式在 Anthropic 纯写入或 input≥cached 的轮次会漏计 write · 虚高命中率
function _cacheInputDenominator(input, cached, cacheWrite, protocol) {
  const inTok = input || 0;
  const cTok = cached || 0;
  const writeTok = cacheWrite || 0;
  if (protocol === "anthropic") return inTok + cTok + writeTok;
  if (protocol) return inTok;
  return cTok > inTok ? inTok + cTok + writeTok : inTok;
}

function _hitRate(input, cached, cacheWrite, protocol) {
  const cTok = cached || 0;
  const denom = _cacheInputDenominator(input, cached, cacheWrite, protocol);
  return _hitRateForDenominator(cTok, denom);
}

function _hitRateForDenominator(cached, denominator) {
  const cTok = cached || 0;
  const denom = denominator || 0;
  if (!denom) return 0;
  return Math.round((cTok / denom) * 1000) / 10; // 百分比 · 一位小数
}
// 估算成本 (仅当渠道配置了 pricing:{inPer1k,outPer1k} 时给出 · 否则 null)
function _estCost(provCfg, input, output) {
  const pr = provCfg && provCfg.pricing;
  if (!pr || (pr.inPer1k == null && pr.outPer1k == null)) return null;
  const ci = ((input || 0) / 1000) * (Number(pr.inPer1k) || 0);
  const co = ((output || 0) / 1000) * (Number(pr.outPer1k) || 0);
  return Math.round((ci + co) * 1e6) / 1e6;
}
function usage() {
  const out = {};
  const providerNames = new Set(Object.keys(_usage));
  for (const sample of _requestHistorySamples) {
    if (sample && sample.provider) providerNames.add(sample.provider);
  }
  for (const name of [...providerNames].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const p = _usage[name] || {
      calls: 0,
      input: 0,
      output: 0,
      cached: 0,
      cacheWrite: 0,
      cacheInput: 0,
      since: 0,
      models: {},
    };
    const provCfg = _providers[name] || {};
    const providerSamples = _requestHistorySamples.filter(
      (sample) => sample.provider === name,
    );
    // The durable rail is the dashboard's source of truth: it survives a
    // desktop restart, while _usage is deliberately process-local.
    const historyUsage = {
      calls: 0,
      input: 0,
      output: 0,
      cached: 0,
      cacheWrite: 0,
      cacheInput: 0,
      since: 0,
      models: {},
    };
    for (const sample of providerSamples) {
      const input = Number(sample.input) || 0;
      const output = Number(sample.output) || 0;
      const cached = Number(sample.cached) || 0;
      const cacheWrite = Number(sample.cacheWrite) || 0;
      historyUsage.calls += 1;
      historyUsage.input += input;
      historyUsage.output += output;
      historyUsage.cached += cached;
      historyUsage.cacheWrite += cacheWrite;
      const sampleCacheInput =
        Number(sample.cacheInput) ||
        _cacheInputDenominator(input, cached, cacheWrite, sample.protocol);
      historyUsage.cacheInput += sampleCacheInput;
      historyUsage.since = historyUsage.since
        ? Math.min(historyUsage.since, Number(sample.at) || Date.now())
        : Number(sample.at) || Date.now();
      const modelName = String(sample.model || "?");
      const modelUsage = historyUsage.models[modelName] || {
        calls: 0,
        input: 0,
        output: 0,
        cached: 0,
        cacheWrite: 0,
        cacheInput: 0,
      };
      modelUsage.calls += 1;
      modelUsage.input += input;
      modelUsage.output += output;
      modelUsage.cached += cached;
      modelUsage.cacheWrite += cacheWrite;
      modelUsage.cacheInput += sampleCacheInput;
      historyUsage.models[modelName] = modelUsage;
    }
    const aggregate = providerSamples.length ? historyUsage : p;
    // A failed request can legitimately finish before any usage arrives. Keep
    // it in the safe request rail, but do not let it distort cache-rate math.
    const cacheSamples = _cacheSamples.filter(
      (sample) =>
        sample.provider === name &&
        (Number(sample.cacheInput) ||
          _cacheInputDenominator(
            sample.input,
            sample.cached,
            sample.cacheWrite,
            sample.protocol,
          )) > 0,
    );
    const recentSamples = cacheSamples.slice(-_CACHE_RECENT_WINDOW);
    const recentInput = recentSamples.reduce(
      (sum, sample) => sum + sample.input,
      0,
    );
    const recentCached = recentSamples.reduce(
      (sum, sample) => sum + sample.cached,
      0,
    );
    const recentCacheWrite = recentSamples.reduce(
      (sum, sample) => sum + sample.cacheWrite,
      0,
    );
    const recentCacheInput = recentSamples.reduce(
      (sum, sample) =>
        sum +
        (Number(sample.cacheInput) ||
          _cacheInputDenominator(
            sample.input,
            sample.cached,
            sample.cacheWrite,
            sample.protocol,
          )),
      0,
    );
    out[name] = {
      calls: aggregate.calls,
      input: aggregate.input,
      output: aggregate.output,
      cached: aggregate.cached || 0,
      cacheWrite: aggregate.cacheWrite || 0,
      cacheInput:
        aggregate.cacheInput ||
        _cacheInputDenominator(
          aggregate.input,
          aggregate.cached,
          aggregate.cacheWrite,
        ),
      hitRate: _hitRateForDenominator(
        aggregate.cached,
        aggregate.cacheInput ||
          _cacheInputDenominator(
            aggregate.input,
            aggregate.cached,
            aggregate.cacheWrite,
          ),
      ),
      recent: {
        window: _CACHE_RECENT_WINDOW,
        calls: recentSamples.length,
        input: recentInput,
        cached: recentCached,
        cacheWrite: recentCacheWrite,
        cacheInput: recentCacheInput,
        hitRate: _hitRateForDenominator(recentCached, recentCacheInput),
      },
      requests: providerSamples.slice(-_CACHE_SAMPLE_LIMIT_PER_PROVIDER),
      total: aggregate.input + aggregate.output,
      since: aggregate.since,
      cost: _estCost(provCfg, aggregate.input, aggregate.output),
      currency: (provCfg.pricing && provCfg.pricing.currency) || "USD",
      models: Object.entries(aggregate.models)
        .map(([m, mm]) => ({
          model: m,
          calls: mm.calls,
          input: mm.input,
          output: mm.output,
          cached: mm.cached || 0,
          cacheWrite: mm.cacheWrite || 0,
          cacheInput:
            mm.cacheInput ||
            _cacheInputDenominator(mm.input, mm.cached, mm.cacheWrite),
          hitRate: _hitRateForDenominator(
            mm.cached,
            mm.cacheInput ||
              _cacheInputDenominator(mm.input, mm.cached, mm.cacheWrite),
          ),
          total: mm.input + mm.output,
        }))
        .sort((a, b) => b.total - a.total),
    };
  }
  return out;
}

// ── lazy load cascade_wire ──────────────────────────────────
function wire() {
  // ★ v9.9.81 · 热重载: 清除 require.cache 使代码修改生效
  //   道义: 十六章「致虚极也」· 虚其缓存 · 方能重新得
  const cwPath = path.join(__dirname, "cascade_wire.js");
  if (require.cache[cwPath]) {
    delete require.cache[cwPath];
    _log("[dao-router] wire() · cascade_wire.js cache cleared");
  }
  try {
    _wire = require(cwPath);
  } catch (e) {
    _log(`[dao-router] cascade_wire load fail: ${e.message}`);
  }
  return _wire;
}

// ════════════════════════════════════════════════════════════════
// §1  公开 API
// ════════════════════════════════════════════════════════════════

/**
 * 初始化 · 加载 daoRoutes 配置
 * @param {{ log: Function, configPath: string }} opts
 * @returns {{ ready: boolean, count?: number, gateway?: string, error?: string }}
 */
function init({ log, configPath }) {
  _log = log || (() => {});
  _upstreamCircuits.clear();
  _clearRoutingDecisions();
  _conversationProviderAffinity.clear();
  _customModelRuntime.clear();
  _routeRuntime.clear();

  // ★ v9.9.81 · 热重载: 清除 require.cache 使代码修改生效
  //   道义: 十六章「致虚极也，守情表也」· 致虚缓存 · 守情代码
  try {
    const selfPath = __filename;
    const cwPath = path.join(__dirname, "cascade_wire.js");
    if (require.cache[selfPath]) delete require.cache[selfPath];
    if (require.cache[cwPath]) delete require.cache[cwPath];
  } catch {}

  _wire = null; // ★ 强制 wire() 重新加载

  // ★ v9.9.86 · 服务端工具补充 · 参数名对齐官方 protobuf schema
  //   逆向实证: CortexStepTrajectorySearch → id/query/id_type (非 ID/Query/SearchType)
  //   CortexStepAskUserQuestion.Request → question/options/allow_multiple
  //   道义: 二十八章「大制无割」· 名实终一 · 参数名与官方同方能通
  _serverToolDefs = [
    {
      name: "dao_tool_search",
      _customModelOnly: true,
      description:
        "Discover deferred MCP tools by capability. Use this only when the required external/connector tool is not currently visible. Search with a concise capability such as 'GitHub pull request', 'browser click', 'web research', or 'library documentation'. Matching tool schemas become available in the next model round.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Capability or external service needed.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 16,
            description: "Maximum matching tools to activate. Defaults to 8.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "dao_read_tool_output",
      _persistedOutputOnly: true,
      description:
        "Read a chunk of a large tool result that was stored locally and replaced by a dao-output:// reference. Use the exact output_id from the tool result. Continue with next_offset only when hasMore is true.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          output_id: {
            type: "string",
            description: "The 32-character output id from dao-output://<id>.",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "Character offset. Defaults to 0.",
          },
          max_chars: {
            type: "integer",
            minimum: 1000,
            maximum: 24000,
            description: "Maximum characters to return. Defaults to 12000.",
          },
        },
        required: ["output_id"],
        additionalProperties: false,
      },
    },
    {
      // 测试结果自报 · 代理层执行 → 写 agent_status.testReport
      //
      // 为什么需要模型自己报，而不是 harness 观测：协议里没有退出码
      // (cascade_wire.js:86-102 全部字段，唯一带外错误信号是
      // TOOL_RESULT_IS_ERROR bool)，代理层也不执行进程、拿不到
      // --junitxml/--json。此前从 stdout 文本推断，五次误判后整段删除
      // (见 agent_status.js _emptyState 处长注释)。
      //
      // 模式来自 ai-agent-book/chapter2/system-hint/agent.py:787
      // _tool_update_todo_status —— 参考实现里唯一带状态的字段(TODO)也是
      // 模型显式调工具写入，不是 harness 猜的。声明可能谎报，但**不会被无关
      // 文本污染**：判据从「文本里像不像」变成「有没有人明确说」。
      //
      // description 里明说「会写进状态栏、会被后续轮次读到」——让模型知道
      // 谎报的后果由自己承担，这是这个模式能成立的前提。
      name: "dao_report_test_result",
      description:
        "Declare the result of a test run you just executed. The two counts are written into your own status bar and will be read back in later turns, so report exactly what the test runner printed — do not estimate. Call this only after actually running tests; if you did not run any, do not call it (absence is recorded as unknown, which is correct). Call it again after a re-run to replace the previous report.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          passed: {
            type: "integer",
            minimum: 0,
            description: "Number of tests that passed, as reported by the runner.",
          },
          failed: {
            type: "integer",
            minimum: 0,
            description:
              "Number of tests that failed, as reported by the runner. Use 0 for a fully green run.",
          },
          framework: {
            type: "string",
            description:
              "Test runner used, e.g. pytest / jest / vitest / node / go test. Lets a reader re-run and verify.",
          },
        },
        // 两个计数都必须给：只说通过数不说失败数无法判断绿红，
        // 那是残缺声明而非部分信息，schema 层就拦住。
        required: ["passed", "failed"],
        additionalProperties: false,
      },
    },
    {
      name: "trajectory_search",
      description:
        "Semantic search or retrieve a conversation trajectory. Trajectories are previous conversations. Returns chunks from the trajectory, scored, sorted, and filtered by relevance. Maximum number of chunks returned is 50. Call this tool when the user @mentions a @conversation. Do NOT call this tool with SearchType: 'user'. IGNORE @activity mentions.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "The ID of the trajectory to search or retrieve: cascade ID for conversations, or mainline ID for user activities",
          },
          query: {
            type: "string",
            description: "The query string to search for within the trajectory",
          },
          id_type: {
            type: "string",
            enum: ["cascade_id", "mainline"],
            description:
              "The type of ID: 'cascade_id' for conversations, or 'mainline' for user activities",
          },
        },
        required: ["id", "query", "id_type"],
        additionalProperties: false,
      },
    },
    {
      name: "code_search",
      description:
        "A search subagent the user refers to as 'Fast Context' that is ideal for exploring the codebase based on a request. This tool invokes a subagent that runs parallel grep and readfile calls over multiple turns to locate line ranges and files which might be relevant to the request. The search term should be a targeted natural language query based on what you are trying to accomplish, like 'Find where authentication requests are handled in the Express routes' or 'Modify the agentic rollout to use the new tokenizer and chat template' or 'Fix the bug where the user gets redirected from the /feed page'. Fill out extra details that you as a smart model can infer in the question if necessary. You should always use this tool to start your search. Note: The files and line ranges returned by this tool may be some of the ones needed to complete the user's request, but you should be careful in evaluating the relevance of the results, since the subagent might make mistakes. You should consider using classical search tools afterwards to locate the rest if necessary. IMPORTANT: YOU CANNOT CALL THIS TOOL IN PARALLEL.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          search_folder_absolute_uri: {
            type: "string",
            description:
              "The absolute path of the folder where the search should be performed. In multi-repo workspaces, you have to specify a subfolder where the search should be performed, to avoid searching across all repos. For example, if you are in the user folder and you don't know what subfolders are present, you have to first list the subfolders and only then call this tool in the subfolder you want to search in.",
          },
          search_term: {
            type: "string",
            description:
              "Search problem statement that this subagent is supposed to research for.",
          },
        },
        required: ["search_folder_absolute_uri", "search_term"],
        additionalProperties: false,
      },
    },
    {
      name: "ask_user_question",
      description:
        'Ask the user a question with predefined options. Use this when you need the user to make a choice between specific options. You can provide up to 4 options, each with a label and description. NEVER include "other" as an option - the user can always automatically provide a custom response. Set allowMultiple to true if the user should be able to select more than one option.',
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask the user",
          },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "Short label for the option",
                },
                description: {
                  type: "string",
                  description: "Longer description explaining the option",
                },
              },
              required: ["label", "description"],
              additionalProperties: false,
            },
            description: "Up to 4 options for the user to choose from",
          },
          allowMultiple: {
            type: "boolean",
            description: "Whether the user can select multiple options",
          },
        },
        required: ["question", "options", "allowMultiple"],
        additionalProperties: false,
      },
    },
    {
      name: "deploy_web_app",
      description:
        "Deploy a JavaScript web application to a deployment provider like Netlify. Site does not need to be built. Only the source files are required. Make sure to run the read_deployment_config tool first and that all missing files are created before attempting to deploy. If you are deploying to an existing site, use the project_id to identify the site. If you are deploying a new site, leave the project_id empty.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          project_path: {
            type: "string",
            description:
              "The full absolute project path of the web application",
          },
          framework: {
            type: "string",
            description: "The framework of the web application",
          },
          project_id: {
            type: "string",
            description:
              "The project ID of the web application if it exists in the deployment configuration file",
          },
          subdomain: {
            type: "string",
            description:
              "Subdomain or project name used in the URL. Leave this EMPTY if you are deploying to an existing site using the project_id.",
          },
        },
        required: ["project_path"],
        additionalProperties: false,
      },
    },
    {
      name: "read_deployment_config",
      description:
        "Read the deployment configuration for a web application and determine if the application is ready to be deployed. Should only be used in preparation for the deploy_web_app tool.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          project_path: {
            type: "string",
            description:
              "The full absolute project path of the web application",
          },
        },
        required: ["project_path"],
        additionalProperties: false,
      },
    },
    {
      name: "check_deploy_status",
      description:
        "Check the status of the deployment using its windsurf_deployment_id for a web application and determine if the application build has succeeded and whether it has been claimed. Do not run this unless asked by the user. It must only be run after a deploy_web_app tool call.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          windsurf_deployment_id: {
            type: "string",
            description:
              "The Windsurf deployment ID for the deploy we want to check status for. This is NOT a project_id.",
          },
        },
        required: ["windsurf_deployment_id"],
        additionalProperties: false,
      },
    },
    {
      name: "skill",
      description:
        "Invoke a skill (custom tool or workflow) by name with optional parameters.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the skill to invoke",
          },
          params: {
            type: "object",
            description: "Parameters to pass to the skill",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  ];
  _serverToolNames = new Set(_serverToolDefs.map((t) => t.name));

  try {
    // ★ v9.9.59 · 配置.json 不存在时: 优先从 _默认配置.json 复制 (DEFECT9 修)
    //   _默认配置.json 打入 VSIX (无凭据模板) · 配置.json 排除 (含用户凭据)
    if (!fs.existsSync(configPath)) {
      const templatePath = path.join(
        path.dirname(configPath),
        "_默认配置.json",
      );
      if (fs.existsSync(templatePath)) {
        _log("[dao-router] 配置.json 不存在 · 从 _默认配置.json 复制");
        try {
          fs.copyFileSync(templatePath, configPath);
        } catch (ce) {
          _log("[dao-router] 复制模板失败: " + ce.message);
        }
      }
    }
    // 仍然不存在则内嵌生成 (兜底)
    // ★ v9.9.98 · 损之又损 · 无为模板 · 只路由SWE 1.6 Fast · 其他走官方
    if (!fs.existsSync(configPath)) {
      _log("[dao-router] 配置.json 不存在 · 内嵌无为模板生成");
      const defaultCfg = {
        _道: "外接api · 道法自然 · 无为模板 · 只路由SWE 1.6 Fast · 其他走官方",
        _注: "无配置=全官方 · 有配置才路由 · 填入apiKey后启用provider",
        gateway: { host: "127.0.0.1", port: 11435 },
        providers: {
          deepseek: {
            enabled: false,
            apiKey: "",
            baseUrl: "https://api.deepseek.com/v1",
            models: ["deepseek-chat", "deepseek-reasoner"],
            noProviderPrefix: true,
            completionPath: "/chat/completions",
            type: "openai-compatible",
            streamMode: "stream",
          },
        },
        daoRoutes: {
          enabled: true,
          substituteEnabled: false,
          allowMcpTools: true,
          _说明:
            "只路由SWE 1.6 Fast → deepseek · 不在表中→官方透传 · 填apiKey后启用provider",
          routes: {
            MODEL_SWE_1_6_FAST: {
              provider: "deepseek",
              model: "deepseek-reasoner",
              _label: "SWE 1.6 Fast → DeepSeek Reasoner (需apiKey)",
              maxOutputTokens: 32768,
            },
          },
        },
      };
      try {
        fs.writeFileSync(
          configPath,
          JSON.stringify(defaultCfg, null, 2),
          "utf8",
        );
        _log("[dao-router] 默认配置已写入: " + configPath);
      } catch (we) {
        _log("[dao-router] 写入默认配置失败: " + we.message);
      }
    }
    const raw = fs.readFileSync(configPath, "utf8");
    _cfg = JSON.parse(raw);
    _loadedConfigFingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify(_cfg), "utf8")
      .digest("hex");
    // ★ v9.9.90 · 存储 configPath · 供热配置 API 持久化使用
    _cfg._configPath = configPath;
    const cacheHistoryPath = path.join(
      path.dirname(configPath),
      ".dao-request-history.json",
    );
    if (_cacheHistoryPath !== cacheHistoryPath) {
      _cacheHistoryPath = cacheHistoryPath;
      _cacheSamples.length = 0;
      _loadRequestHistory(cacheHistoryPath);
    }
    const decisionStatePath = path.join(
      path.dirname(configPath),
      "route-decision-inbox.json",
    );
    if (
      _routeDecisionStoreFactory &&
      typeof _routeDecisionStoreFactory.createRouteDecisionStore ===
        "function" &&
      (!_routeDecisionStore || _routeDecisionStatePath !== decisionStatePath)
    ) {
      _routeDecisionStore = _routeDecisionStoreFactory.createRouteDecisionStore(
        {
          statePath: decisionStatePath,
        },
      );
      _routeDecisionStatePath = decisionStatePath;
    }
    // ★ 动作审计落盘: 配置同目录 .action-audit.jsonl
    if (_actionAudit)
      _actionAudit.init({
        auditPath: path.join(path.dirname(configPath), ".action-audit.jsonl"),
      });
    const dr = _cfg.daoRoutes || {};
    // 可选覆盖：daoRoutes.resilience.circuit={strikeThreshold,strikeWindowMs,earlyProbeMs,probeLeadMs,restoreAffinity}
    const configuredCircuit = (dr.resilience && dr.resilience.circuit) || {};
    _circuitPolicy = {
      ..._DEFAULT_CIRCUIT_POLICY,
      ...Object.fromEntries(
        Object.entries(configuredCircuit).filter(
          ([key, value]) =>
            [
              "strikeThreshold",
              "strikeWindowMs",
              "earlyProbeMs",
              "probeLeadMs",
              "restoreAffinity",
              "probeIntervalMs",
            ].includes(key) && value !== undefined,
        ),
      ),
    };
    _circuitPolicy.strikeThreshold = Math.max(
      1,
      Number(_circuitPolicy.strikeThreshold) || 3,
    );
    _circuitPolicy.strikeWindowMs = Math.max(
      1000,
      Number(_circuitPolicy.strikeWindowMs) || 60000,
    );

    if (dr.enabled === false) {
      _ready = false;
      _log("[dao-router] daoRoutes.enabled=false · 透明路由已禁用");
      return { ready: false, reason: "disabled" };
    }

    // 加载路由表 (过滤掉 _注 等注释键)
    const rawRoutes = dr.routes || {};
    _routes = {};
    for (const [uid, t] of Object.entries(rawRoutes)) {
      if (uid.startsWith("_") || typeof t !== "object" || !t.provider) continue;
      _routes[uid] = _normalizeQualityRoute(uid, t);
    }

    // ★ v9.9.316 · 免费模型并存修复 · 不再播种 MODEL_SWE_1_6 → builtin-stub
    //   道义: 二章「为而弗恃」· 四十八章「损之又损 以至于无为」· 损去多余之桩
    //   实证(VM): 播种基础档 → builtin-stub 后 · 用户选免费 SWE-1.6 收到固定桩文本
    //     (「stub响应正常」) 而非官方真实回复 → 免费模型无法与 Proxy Pro 并存
    //   根因: 基础档被桩占据 → shouldRoute 命中桩路由 → 官方透传被劫持
    //   修复: 基础档不入路由表 → shouldRoute 返回 false → 回落官方上游(免费原生)
    //     仅 SWE 1.6 Fast 按配置路由(deepseek) · 未填 apiKey 时亦回落官方

    // 加载 providers
    _providers = Object.fromEntries(
      Object.entries(_cfg.providers || {}).map(([name, provider]) => [
        name,
        { ...provider },
      ]),
    );
    for (const provider of Object.values(_providers)) {
      const keychainRef = String((provider && provider.apiKey) || "").trim();
      if (provider && keychainRef.startsWith("keychain:")) {
        Object.defineProperty(provider, "_keychainApiKeyRef", {
          value: keychainRef,
          enumerable: false,
        });
        provider.apiKey = _resolveKeychainApiKey(keychainRef);
      }
    }
    _customModels = _cfg.customModels || {};

    // ★ 道法自然 · 渠道地址自愈 (载入即归一 · 不止新增时)
    //   历史/手填 baseUrl 误含完整补全端点 (如小米 .../v1/chat/completions) →
    //   剥为真根, 由 completionPath 单次拼接; 探活/解模型/对话三处皆受其益。
    //   道义: 二十八章「复归于朴」· 去其华饰 复其本根 · 名实相符方能通。
    for (const _pn of Object.keys(_providers)) {
      const _pc = _providers[_pn];
      if (_pc && _pc.baseUrl) {
        const _nb = _stripCompletionSuffix(_pc.baseUrl);
        if (_nb && _nb !== String(_pc.baseUrl).replace(/\/+$/, "")) {
          _log(
            `[dao-router] [载] provider ${_pn}: baseUrl 自愈归一 ${_pc.baseUrl} → ${_nb}`,
          );
          _pc.baseUrl = _nb;
        }
      }
    }

    // 全局 substitute 开关
    _substituteEnabled = dr.substituteEnabled === true;
    if (!_substituteEnabled) {
      _log("[dao-router]   substitute模式: 关闭 (substituteEnabled=false)");
    }

    // ★ 同族档位自动延伸开关 (连一档是否覆盖全族) · 默认关闭(可显式 familyTierExtend:true 开)
    //   关(默认): swe-1-6-slow 等未显式连线之档保持官方原生直通 · 即「默认走官方·免费不路由」
    //     —— 用户旨意: fast 档随首个渠道自动路由 · slow 档默认官方 · 仅显式连线方路由第三方
    //   开(可选): 同族任一档位被显式连线 → 全族档位(含 catalog 无独立项的 slow)归一其渠道
    //   守常: 仅延伸「含真实非播种路由」之族 · 纯播种桩族(无真路由)仍保官方直通
    //   道义: 二十五章「道法自然」· 唯变所适 · 默认顺其自然(官方) · 用户欲连方延伸
    _familyTierExtend = dr.familyTierExtend === true;
    _log(
      "[dao-router]   同族档位延伸: " +
        (_familyTierExtend ? "开 (连一档覆盖全族)" : "关 (显式逐档路由)"),
    );

    // ★ v9.9.88 · MCP 工具过滤开关 (移植自 EXE ALLOW_MCP_TOOLS)
    //   默认 true: 允许 mcp\d+_ 前缀的工具传给上游模型
    //   设为 false: 仅传 _KNOWN_TOOL_NAMES 白名单内的工具
    _allowMcpTools = dr.allowMcpTools !== false;
    _log("[dao-router]   MCP工具: " + (_allowMcpTools ? "允许" : "仅白名单"));

    const gw = _cfg.gateway || {};
    _gatewayUrl = `http://${gw.host || "127.0.0.1"}:${gw.port || 11435}`;
    const count = Object.keys(_routes).length;
    _ready = count > 0;

    if (_ready) {
      _log("[dao-router] ══════════════════════════════════════════");
      _log(`[dao-router] 道路由 v2.0 就绪 · routes=${count}`);
      const provCounts = {};
      for (const t of Object.values(_routes)) {
        provCounts[t.provider] = (provCounts[t.provider] || 0) + 1;
      }
      for (const [p, n] of Object.entries(provCounts)) {
        const pCfg = _providers[p] || {};
        const proto = pCfg.protocol || "(auto)";
        _log(
          `[dao-router]   ${p}: ${n}条 · url=${pCfg.baseUrl || _gatewayUrl} · protocol=${proto}`,
        );
      }
      // ★ v9.9.99 · 日志 per-route 预算/弹性配置
      for (const [uid, t] of Object.entries(_routes)) {
        const parts = [uid, "→", `${t.provider}/${t.model}`];
        if (t.thinkingEnabled) parts.push("thinking");
        if (t.budget) parts.push(`budget(ctx=${t.budget.maxContextTokens})`);
        if (t.resilience)
          parts.push(`resilience(retry=${t.resilience.maxRetries})`);
        _log(`[dao-router]   ${parts.join(" ")}`);
      }
      _log("[dao-router] ══════════════════════════════════════════");
    } else {
      _log("[dao-router] 无路由配置");
    }

    wire();

    // ★ v9.9.62 · 配置.json 文件监听 · 变化时自动热重载 · 道法自然
    //   帛书·十六: 「致虚极也，守情表也」— 守住变化，不执着于旧
    if (!_cfgWatcher && fs.existsSync(configPath)) {
      try {
        const cfgDir = path.dirname(configPath);
        const cfgBase = path.basename(configPath);
        let _cfgDebounce = null;
        _cfgWatcher = fs.watch(cfgDir, (eventType, filename) => {
          if (filename !== cfgBase) return;
          if (_cfgDebounce) clearTimeout(_cfgDebounce);
          _cfgDebounce = setTimeout(() => {
            _cfgDebounce = null;
            // ★ 自写抑制: 若磁盘内容与本进程刚写入的内容一致 → 是自写 · 跳过热重载
            //   根除「加渠道/解模型 → 触发 watch → init() 重载 → 内存改写被冲掉」的竞态
            try {
              const _cur = fs.readFileSync(configPath, "utf8");
              if (_lastSelfWriteData !== null && _cur === _lastSelfWriteData) {
                return;
              }
            } catch {}
            _log("[dao-router] 配置.json 外部变化检测 · 自动热重载...");
            try {
              const reResult = init({ log: _log, configPath });
              if (reResult.ready) {
                _log(
                  "[dao-router] ★ 配置热重载成功 · " +
                    reResult.count +
                    "条路由",
                );
              } else {
                _log(
                  "[dao-router] 配置热重载失败: " +
                    (reResult.error || reResult.reason),
                );
              }
            } catch (e) {
              _log("[dao-router] 配置热重载异常: " + e.message);
            }
          }, 500);
        });
        if (_cfgWatcher.unref) _cfgWatcher.unref();
        _log("[dao-router] 配置监听已启动 · " + configPath);
      } catch (e) {
        _log("[dao-router] 配置监听启动失败 (不影响运行): " + e.message);
      }
    }

    // ★ v9.9.99 · 初始化 Go 移植模块 · 道法自然
    //   预算 · 适配 · 弹性 · 三位一体 · 无为而无不为
    try {
      if (_budget) _budget.initBudget({ log: _log });
      if (_adapters) _adapters.initAdapters({ log: _log });
      if (_resilience) _resilience.initResilience({ log: _log });
      if (_contextStrategy) _contextStrategy.init({ log: _log });
      if (_toolStrategy) _toolStrategy.init({ log: _log });
      if (_promptCachePolicy) _promptCachePolicy.dispose();
      _promptCachePolicy = _promptCachePolicyFactory
        ? _promptCachePolicyFactory({
            log: _log,
            sendWarmup: _sendPromptCacheWarmup,
          })
        : null;
      if (_workspaceToolStrategy) {
        _workspaceToolStrategy.init({ log: _log, localFallback: true });
      }
      if (_toolOutputStore) {
        _toolOutputStore.init({
          log: _log,
          dir: path.join(path.dirname(configPath), "tool-output-cache"),
        });
      }
      _initOtelExporter();
      _log(
        "[dao-router] ★ 核心模块初始化完成: budget + adapters + resilience + context/tool/workspace/cache-strategy",
      );
    } catch (e) {
      _log(`[dao-router] ⚠️ Go移植模块初始化失败: ${e.message} · 降级为旧逻辑`);
    }

    return {
      ready: _ready,
      count,
      gateway: _gatewayUrl,
      providers: Object.keys(_providers),
    };
  } catch (e) {
    _log(`[dao-router] init 失败: ${e.message}`);
    _ready = false;
    return { ready: false, error: e.message };
  }
}

/** 是否就绪 */
function isReady() {
  return _ready;
}

/**
 * 从 GetChatMessage 原始 body 快速提取 modelUid
 * 用于 MITM 早期路由决策
 */
function extractModelUid(rawBody, isJSON) {
  try {
    const w = wire();
    if (!w) {
      _log("[dao-router] extractModelUid: wire()=null");
      return null;
    }
    const parsed = w.parseGetChatMessageRequest(rawBody, !!isJSON);
    if (!parsed) {
      _log(
        "[dao-router] extractModelUid: parsed=null isJSON=" +
          isJSON +
          " bodyLen=" +
          (rawBody ? rawBody.length : 0),
      );
      return null;
    }
    if (!parsed.modelUid) {
      _log(
        "[dao-router] extractModelUid: modelUid='' isJSON=" +
          isJSON +
          " bodyLen=" +
          (rawBody ? rawBody.length : 0) +
          " keys=" +
          Object.keys(parsed).join(","),
      );
      return null;
    }
    return parsed.modelUid;
  } catch (e) {
    _log(
      "[dao-router] extractModelUid ERR: " +
        e.message +
        " isJSON=" +
        isJSON +
        " bodyLen=" +
        (rawBody ? rawBody.length : 0),
    );
    return null;
  }
}

// ★ v9.9.279 · 服务档位变体后缀 · 同一模型族多档位下发不同 uid
//   Windsurf 实测下发 uid 带档位后缀 (swe-1-6-slow / swe-1-6-fast ...) ·
//   皆属同一模型族 swe-1-6 · 用户在③模型路由连族即应覆盖其全部档位
const _VARIANT_SUFFIXES = [
  "slow",
  "fast",
  "lite",
  "pro",
  "mini",
  "thinking",
  "reasoning",
  "high",
  "low",
  "medium",
];

// 剥离档位后缀 → 模型族基名 (兼容 - 与 _ 两种分隔)
//   swe-1-6-slow → swe-1-6 · MODEL_SWE_1_6_SLOW → MODEL_SWE_1_6
function _stripVariantSuffix(uid) {
  if (!uid || typeof uid !== "string") return uid;
  const lower = uid.toLowerCase();
  for (const v of _VARIANT_SUFFIXES) {
    if (lower.endsWith("-" + v) || lower.endsWith("_" + v)) {
      return uid.slice(0, uid.length - (v.length + 1));
    }
  }
  return uid;
}

// ★ 模型族规范名 · 去 MODEL_ 前缀 + 统一连字符 + 小写 + 剥档位后缀
//   swe-1-6-slow / swe-1-6-fast / MODEL_SWE_1_6_FAST / MODEL_SWE_1_6 → "swe-1-6"
//   用于"连一档即覆盖全族"的同族匹配 · 道义: 二十五章「道法自然·名异实同」
function _familyCanon(uid) {
  if (!uid || typeof uid !== "string") return "";
  let s = uid;
  if (s.startsWith("MODEL_")) s = s.slice("MODEL_".length);
  s = s.replace(/_/g, "-").toLowerCase();
  return _stripVariantSuffix(s);
}

/**
 * modelUid 规范化 · DEFECT11 根治
 *   Windsurf modelUid 格式不一致:
 *     · 内置模型: MODEL_SWE_1_6_FAST (大写MODEL_前缀+下划线)
 *     · 第三方/新增: swe-1-6-fast (小写连字符)
 *   路由表 key 两种都写入, shouldRoute 自动规范化匹配
 */
function _normalizeModelUid(uid) {
  if (!uid || typeof uid !== "string") return uid;
  // 1) 直接命中
  if (_routes[uid]) return uid;
  // 2) 小写连字符 → MODEL_ 格式: swe-1-6-fast → MODEL_SWE_1_6_FAST
  if (!uid.startsWith("MODEL_")) {
    const modelKey = "MODEL_" + uid.replace(/-/g, "_").toUpperCase();
    if (_routes[modelKey]) return modelKey;
  }
  // 3) MODEL_ 格式 → 小写连字符: MODEL_SWE_1_6_FAST → swe-1-6-fast
  if (uid.startsWith("MODEL_")) {
    const lowerKey = uid
      .replace(/^MODEL_/, "")
      .replace(/_/g, "-")
      .toLowerCase();
    if (_routes[lowerKey]) return lowerKey;
  }
  // 3.5) ★ v9.9.280 · 档位变体兜底 · 仅延伸"用户显式连线"的族 · 不延伸系统默认桩
  //   道义: 二十五章「道法自然」· 名异而实同 · 守族之常
  //   关键: 自动播种(_seeded)的 MODEL_SWE_1_6 测试桩不得吞并兄弟档位 →
  //         swe-1-6-slow 等未显式连线者保持官方透传(免费原生·用户旨意)
  //   仅当精确/形态匹配皆未命中, 且族基名被用户"显式"(非_seeded)连线时方触发
  //   ★ 受 daoRoutes.familyTierExtend 闸控 · 默认开(可显式置 false 关) · 守「连族即覆盖全档」之本
  //     (slow 等档 catalog 无独立项·无法单独连线 → 必经此延伸方能命中用户所连渠道)
  if (_familyTierExtend) {
    const base = _stripVariantSuffix(uid);
    if (base && base !== uid) {
      // ★ v9.9.284 · 真实可路由判定: 非播种 + 非桩/替身 + 未禁用
      //   关键(VM实证): 族基名若为 builtin-stub 基线档(MODEL_SWE_1_6→测试桩)·
      //     不得吞并 slow/fast/lite 变体之真实聊天流 → 让其落入 3.6 择优真实渠道
      const _real = (k) => {
        const r = _routes[k];
        if (!r || r._seeded) return false;
        if (r.provider === "builtin-stub" || r.provider === "substitute")
          return false;
        if (r.enabled === false) return false;
        return true;
      };
      if (_real(base)) return base;
      if (!base.startsWith("MODEL_")) {
        const baseModelKey = "MODEL_" + base.replace(/-/g, "_").toUpperCase();
        if (_real(baseModelKey)) return baseModelKey;
      } else {
        const baseLowerKey = base
          .replace(/^MODEL_/, "")
          .replace(/_/g, "-")
          .toLowerCase();
        if (_real(baseLowerKey)) return baseLowerKey;
      }
    }
    // 3.6) ★ v9.9.282 · 同族兄弟档位匹配 · 连一档即覆盖全族 (软编码·为变所适)
    //   真因(141实证): 用户在UI仅连 swe-1-6-fast → deepseek · 但发消息时
    //     Windsurf 默认下发 swe-1-6-slow · 档位对不上 → 不路由 → 走官方 → 501回弹
    //   旧逻辑(3.5)仅认"族基名本身"被连线 · 不认"兄弟档位"被连线 → 漏判
    //   治: 只要同族任一档位被用户"显式"(非_seeded)连线 · 则全族档位归一其渠道
    //   守常: 仅延伸"用户已连"之族 · 纯播种桩族(无真路由)仍保官方原生直通
    //   道义: 二十八章「朴散为器·大制无割」· 四十八章「损之又损·以至无为而无不为」
    const _qFam = _familyCanon(uid);
    if (_qFam) {
      const _sibs = Object.keys(_routes)
        .filter(
          (k) => _routes[k] && !_routes[k]._seeded && _familyCanon(k) === _qFam,
        )
        .sort();
      if (_sibs.length) {
        // ★ v9.9.284 · 兄弟档位择优 (VM实证修正): 真实外接渠道 > builtin-stub/substitute
        //   真因: 旧逻辑取 _sibs.sort()[0] (字典序) · 若同族存在 builtin-stub 基线档
        //     (如 MODEL_SWE_1_6 且非_seeded) · 它排在 MODEL_SWE_1_6_FAST 之前 → 真实
        //     聊天被导到桩(固定返回) · 而非用户连的 deepseek。141 仅因该桩恰为 _seeded
        //     被剔除才侥幸正确 · 配置稍变即暴露。
        //   治: 优先选"真实外接 provider 且 enabled"之兄弟档 · 无则回落任一兄弟档
        //   道义: 二十七章「善救物·故无弃物」· 桩仅验通路·不夺真流
        const _realSib = _sibs.filter((k) => {
          const p = _routes[k].provider;
          return (
            p &&
            p !== "builtin-stub" &&
            p !== "substitute" &&
            _routes[k].enabled !== false
          );
        });
        return (_realSib.length ? _realSib : _sibs)[0];
      }
    }
  } // end if(_familyTierExtend) · 同族档位延伸
  // 4) ★ v9.9.59 · 通配符兜底: * → 任何未知模型自动路由
  if (_routes["*"]) return "*";
  return uid; // 无法规范化则原样返回
}

/**
 * 判断是否应路由此 modelUid
 */
function shouldRoute(modelUid) {
  if (typeof modelUid !== "string") return false;
  // ★ v9.9.98 · 无配置=全官方 · 有配置才路由 · 道法自然
  //   _ready=false: 无路由配置 → 所有模型走官方透传
  //   _ready=true: 有路由配置 → stub模型走内建桩 · 其他按路由表
  if (!_ready || !_daoRoutesEnabled()) return false;
  if (_STUB_MODELS.has(modelUid)) return true;
  // ★ v9.9.97 · 保护模型检查 · family级别匹配 · 用户显式解锁才可路由
  if (isModelProtected(modelUid)) return false;
  const normalized = _normalizeModelUid(modelUid);
  const r = _routes[normalized];
  if (!r) return false;
  // 路由条目 enabled:false → 不路由 (substitute默认关闭)
  if (r.enabled === false) return false;
  // substitute模式需要全局开关
  if (r.provider === "substitute" && !_substituteEnabled) return false;
  // ★ 通配符 * 始终可路由
  if (normalized === "*") return true;
  return true;
}

/**
 * ★ v9.9.283 · 路由解析(对外暴露) · 与 route()/shouldRoute() 同源解析
 *   返回内部 _routes 真实命中目标 · 供 test-chat 等诊断按"真路由"显示
 *   真因: 旧 test-chat 直查持久化 config.daoRoutes.routes · 不经 _normalizeModelUid
 *     → 同族兄弟档位(如 swe-1-6-slow)虽 shouldRoute=true 却被误报"route config not found"
 *   治: 诊断改用本函数 · 与真实推理路径同一张 _routes 表 · 名实相符
 *   道义: 二十一章「其名不去·以顺众父」· 二十五章「道法自然」
 */
function resolveRoute(modelUid) {
  if (typeof modelUid !== "string") return null;
  const normalized = _normalizeModelUid(modelUid);
  const r = _materializeRouteReference(_routes[normalized]);
  if (!r) return null;
  return {
    modelUid,
    normalized,
    provider: r.provider,
    model: r.model,
    route: r,
  };
}

function _materializeRouteReference(route, seen) {
  if (!route || typeof route !== "object") return route || null;
  const ref = String(route._customModelRef || "").trim();
  if (!ref) return route;
  const visited = seen || new Set();
  if (visited.has(ref)) return null;
  visited.add(ref);
  const linked = _materializeRouteReference(_routes[ref], visited);
  if (!linked || linked._customModelId !== ref) return null;
  return {
    ...route,
    ...linked,
    _customModel: false,
    _customModelId: undefined,
    _customModelRef: ref,
    _label: route._label || `共享自定义模型 ${ref}`,
  };
}

/**
 * 路由执行: GetChatMessage → 第三方API
 *
 * @param {http.IncomingMessage}  req      - 原始请求 (用于 close 监听)
 * @param {http.ServerResponse}   res      - HTTP 响应
 * @param {Buffer}                rawBody  - GetChatMessageRequest 原始 body
 * @param {boolean}               isJSON   - content-type 含 'json' 则 true
 * @param {string}                modelUid - 模型 UID
 * @returns {Promise<boolean>} true=路由成功已响应 / false=应回落到官方
 */
async function route(req, res, rawBody, isJSON, modelUid) {
  const normalized = _normalizeModelUid(modelUid);
  let target = _materializeRouteReference(_routes[normalized]);
  // ★ v9.9.73c · 硬编码 stub: swe-1-6 始终走 builtin-stub
  //   配置文件可能被外部进程覆盖 · 但代码中的路由不可覆
  //   v9.9.73b 的 !target 条件有漏洞: 配置中有 swe-1-6→deepseek 时 target 非空 → stub 被绕过
  //   修正: 无条件覆盖 · _STUB_MODELS 中的模型永远走 builtin-stub
  if (_STUB_MODELS.has(modelUid)) {
    target = _STUB_TARGET;
    _routeDiag(
      "route() hardcoded stub: modelUid=" +
        modelUid +
        " → builtin-stub (强制覆盖 · 不受配置影响)",
    );
    _log(
      "[dao-router] [stub→] " +
        modelUid +
        " → builtin-stub (硬编码 · 不受配置影响)",
    );
  }
  // ★ v9.9.67 · 诊断日志 — 路由入口
  _log(
    `[dao-router] route() entry: modelUid=${modelUid} normalized=${normalized} target=${target ? target.provider + "/" + target.model : "null"} isJSON=${isJSON} bodyLen=${rawBody ? rawBody.length : 0}`,
  );
  _routeDiag(
    `route() entry: modelUid=${modelUid} normalized=${normalized} target=${target ? target.provider + "/" + target.model : "null"} bodyLen=${rawBody ? rawBody.length : 0}`,
  );
  // ★ 链路追踪: 本笔请求全轨迹 (路由→重试→换渠道→降级)
  const _rt = _traceCenter ? _traceCenter.begin({ modelUid }) : null;
  if (!target) {
    _routeDiag(`route() SKIP: no target for ${normalized}`);
    if (_rt) _rt.end("skipped", "无路由目标");
    return false;
  }
  if (_rt)
    _rt.step("route_entry", {
      target: `${target.provider}/${target.model}`,
    });
  target = { ...target, _routeUid: normalized };
  // ★ 通配符兜底: 用原始 modelUid 作为 model 名发给 provider
  const _isWildcard = normalized === "*";

  _stats.total++;
  const w = wire();
  if (!w) {
    _log(`[dao-router] [SKIP] cascade_wire 不可用 · ${modelUid}`);
    _routeDiag(`route() SKIP: wire=null for ${modelUid}`);
    _stats.errors++;
    if (_rt) _rt.end("error", "cascade_wire 不可用");
    return false;
  }

  // ── 解析 GetChatMessageRequest ──
  let parsed;
  try {
    parsed = w.parseGetChatMessageRequest(rawBody, !!isJSON);
    if (!parsed) throw new Error("parse returned null");
    // ★ v9.9.67 · 诊断: 解析后消息数
    _log(
      `[dao-router] parse ok: msgs=${parsed.messages?.length || 0} tools=${parsed.tools?.length || 0} sysLen=${parsed.system?.length || 0}`,
    );
    _routeDiag(
      `route() parse ok: msgs=${parsed.messages?.length || 0} tools=${parsed.tools?.length || 0} sysLen=${parsed.system?.length || 0} modelUid=${parsed.modelUid}`,
    );
  } catch (e) {
    _log(`[dao-router] [SKIP] parse 失败: ${e.message} · ${modelUid}`);
    _routeDiag(
      `route() SKIP: parse fail: ${e.message} bodyLen=${rawBody?.length} isJSON=${isJSON}`,
    );
    _stats.errors++;
    if (_rt) _rt.end("error", `请求解析失败: ${e.message}`);
    return false;
  }

  // ★ v9.9.83 · 诊断: LSP 原始 tools + SP 完整转储 (默认关 · 仅排障开)
  //   道义: 十六章「万物旁作 吾以观其复也」· 观其所发 · 方知其所缺
  if (_debugDumpEnabled()) try {
    const lspDumpPath = path.join(__dirname, "_lsp_parsed_dump.json");
    const lspDumpObj = {
      _ts: new Date().toISOString(),
      _cascadeId: parsed.cascadeId || "",
      _promptId: parsed.promptId || "",
      _promptCacheKey: _conversationPromptCacheKey(parsed),
      _modelUid: parsed.modelUid,
      _sysLen: (parsed.system || "").length,
      _sysHash: _cacheFingerprint(parsed.system || ""),
      _toolsHash: _cacheFingerprint(parsed.tools || []),
      _sysPreview: (parsed.system || "").substring(0, 800),
      // ★ v9.9.83 · 完整 SP (确认 tool_calling 区块)
      _sysFull: parsed.system || "",
      _msgCount: (parsed.messages || []).length,
      // ★ v9.9.83 · 完整工具定义 (含 parameters, 确认 schema 一致性)
      _toolsFromLSP: (parsed.tools || []).map((t) => {
        const fn = t.function || t;
        return {
          name: fn.name || t.name,
          description: (fn.description || t.description || "").substring(
            0,
            200,
          ),
          parameters: fn.parameters || t.parameters || null,
        };
      }),
      _toolNames: (parsed.tools || []).map(
        (t) => (t.function || t).name || t.name,
      ),
      _toolChoice: parsed.toolChoice,
      _disableParallel: parsed.disableParallelToolCalls,
    };
    fs.writeFile(lspDumpPath, JSON.stringify(lspDumpObj, null, 2), () => {});
  } catch (_le) {}

  const _proxyManagedExecution = _usesProxyManagedExecution(target);
  let messages = _buildOAMessages(parsed);
  // Preserve Devin's native transcript. Placeholder tool results are only a
  // compatibility repair for routes that explicitly opt into proxy execution.
  if (_proxyManagedExecution) messages = _fixOAMessages(messages);
  const _conversationKey = _conversationPromptCacheKey(parsed);
  messages = _injectLocalToolTranscript(_conversationKey, messages);
  let _workspaceToolStats = null;
  if (_proxyManagedExecution && _workspaceToolStrategy) {
    try {
      _workspaceToolStats = _workspaceToolStrategy.observe({
        key: _conversationKey,
        messages,
      });
      messages = _workspaceToolStrategy.decorateMessages({
        key: _conversationKey,
        messages,
      });
    } catch (error) {
      _log(`[dao-router] workspace-tool-strategy 观察异常: ${error.message}`);
    }
  }
  const _allRouteTools =
    _proxyManagedExecution && _workspaceToolStrategy
      ? _workspaceToolStrategy.filterTools({
          key: _conversationKey,
          tools: parsed.tools,
        })
      : parsed.tools;
  let routeTools = _allRouteTools;
  let _toolOutputStats = null;
  let _toolStrategyStats = null;
  const _customRecord =
    target && target._customModel
      ? _customModels[target._customModelId] || {}
      : {};
  const _contextConfig = (target && target.contextStrategy) || {};
  let _contextMaxTokens =
    target && target._customModel
      ? Number(_contextConfig.maxContextTokens) ||
        Number(target.budget && target.budget.maxContextTokens) ||
        Number(_customRecord.contextTokens) ||
        (_adapters ? _adapters.pickContextLength(target.model) : 131072)
      : null;
  const _providerStreamCapable =
    ((_providers[target.provider] || {}).streamMode || "stream") !== "unary";
  const _persistToolOutputs = _usesPersistedToolOutputs(
    target,
    _providers[target.provider] || {},
    target.model,
  );
  if (_toolOutputStore && _providerStreamCapable && _persistToolOutputs) {
    try {
      const compactedOutput = _toolOutputStore.compactMessages(messages, {
        preserveRecentToolResults: 4,
      });
      messages = compactedOutput.messages;
      _toolOutputStats = {
        compacted: compactedOutput.compacted,
        savedChars: compactedOutput.savedChars,
        preservedRecent: compactedOutput.preservedRecent,
      };
      if (_toolOutputStats.compacted > 0) {
        _routeDiag(
          `route() tool-output-store: compacted=${_toolOutputStats.compacted} savedChars=${_toolOutputStats.savedChars}`,
        );
      }
    } catch (error) {
      _log(`[dao-router] tool-output-store 异常: ${error.message}`);
    }
  }
  if (
    _toolStrategy &&
    _proxyManagedExecution &&
    _providerStreamCapable &&
    _contextConfig.deferMcpTools === true
  ) {
    try {
      const selection = _toolStrategy.select({
        key: _conversationKey,
        tools: _allRouteTools,
        messages,
        maxContextTokens: _contextMaxTokens,
      });
      routeTools = selection.tools;
      _toolStrategyStats = selection.stats;
    } catch (error) {
      _log(`[dao-router] tool-strategy 预选异常: ${error.message}`);
    }
  }

  // ★ v9.9.99 · Token 预算管理 (移植自 Go budget.Apply)
  //   道义: 四十四章「知足不辱 知止不殆 可以长久」
  //   知其token之所耗 · 方知其所止 · 止而不殆
  let _budgetStats = null;
  let _contextStats = null;
  if (
    _contextStrategy &&
    _proxyManagedExecution &&
    target.provider !== "builtin-stub" &&
    _contextConfig.enabled === true
  ) {
    try {
      const contextResult = _contextStrategy.apply({
        key: _conversationKey,
        messages,
        tools: routeTools,
        maxContextTokens: _contextMaxTokens,
        maxOutputTokens:
          target.maxOutputTokens || _customRecord.maxOutputTokens || 16384,
        highWaterTokens: _contextConfig.highWaterTokens,
        lowWaterTokens: _contextConfig.lowWaterTokens,
      });
      messages = contextResult.messages;
      routeTools = contextResult.tools;
      _contextStats = contextResult.stats;
      _routeDiag(
        `route() context-strategy: raw=${_contextStats.rawTokens} sent=${_contextStats.sentTokens} saved=${_contextStats.savedTokens} checkpoint=${_contextStats.checkpointId}${_contextStats.checkpointReused ? ":reused" : ""} trimmed=${_contextStats.trimmedMessages} water=${_contextStats.lowWaterTokens}/${_contextStats.highWaterTokens}`,
      );
    } catch (e) {
      _log(`[dao-router] context-strategy 异常: ${e.message}`);
    }
  } else if (
    _proxyManagedExecution &&
    _budget &&
    target &&
    target.provider !== "builtin-stub"
  ) {
    const budgetOutcome = _applyRequestBudget({
      messages,
      tools: routeTools,
      system: parsed.system || "",
      budget: target.budget || null, // ★ per-route 预算配置
      modelUid,
    });
    messages = budgetOutcome.messages;
    routeTools = budgetOutcome.tools;
    _budgetStats = budgetOutcome.stats;
  }

  // ★ v9.9.99 · 协议自动检测 (移植自 Go adapters.detectProtocol)
  //   道义: 道法自然 · 自动识别 · 无需手动指定
  let _detectedProtocol = null;
  if (_adapters && target && target.provider !== "builtin-stub") {
    try {
      const provCfg = _providers[target.provider] || {};
      _detectedProtocol = _resolveTargetProtocol(target, provCfg, target.model);
      if (_detectedProtocol !== "openai-chat") {
        _routeDiag(
          `route() protocol: ${_detectedProtocol} (explicit model setting or detected for ${target.provider}/${target.model})`,
        );
      }
    } catch (e) {
      _log(`[dao-router] detectProtocol 异常: ${e.message}`);
    }
  }

  // ★ v9.9.92 · 修法⑦ · SP 检测+日志 · 最上游 · 不修改
  //   道义: source.js 已在最上游修改 SP → 此处仅检测一致性
  //   若 SP 未道化 → 日志警告 (source.js 可能未生效)
  //   若 SP 已道化 → 日志确认 (全链路一致)
  //   不做任何修改 · 不做任何补丁 · 只观不造
  if (
    messages.length > 0 &&
    messages[0].role === "system" &&
    messages[0].content
  ) {
    const _sysContent = messages[0].content;
    if (_spInvert) {
      if (_spInvert.isAlreadyInverted(_sysContent)) {
        _routeDiag(
          `[dao-router] [SP已道化] ✓ 幂等确认 ${_sysContent.length}B · source.js最上游已生效`,
        );
      } else if (_sysContent.indexOf("<!-- DAO-ENHANCE") >= 0) {
        // ★ v9.9.101 · 太上下知有之 · 增强模式 · 官方SP保留 + DAO增强
        _routeDiag(
          `[dao-router] [SP已增强] ✓ 太上模式 ${_sysContent.length}B · 官方SP保留 + DAO增强 · 工具指令完整`,
        );
      } else if (_spInvert.isLikelyOfficialSP(_sysContent)) {
        _routeDiag(
          `[dao-router] [SP未道化] ⚠ 官方SP ${_sysContent.length}B · source.js可能未生效 · 透传`,
        );
        // ★ 不修改 · 最上游原则 · 仅日志
      } else {
        const _spType = _spInvert.classifySPType(_sysContent);
        if (_spType) {
          _routeDiag(
            `[dao-router] [SP类型=${_spType}] ${_sysContent.length}B · 非chat主路 · source.js副路处理`,
          );
        }
      }
    }
  }

  // ★ v9.9.83 · LSP 原始工具名集合
  //   道义: 二十八章「知其白 守其辱」· 知 LSP 所发 · 守 IS_CUSTOM_TOOL 正位
  //   根因: _serverToolNames 是静态集合 · LSP 可能已通过 GetSystemPromptAndTools 发送 trajectory_search
  //   若仅凭 _serverToolNames 判断 isCustomToolCall → 官方工具被误标为 custom → LSP 路由失败
  const _lspToolNames = new Set(
    (parsed.tools || []).map((t) => (t.function || t).name || t.name),
  );
  _lspToolNames.requiredArgs = new Map(
    (parsed.tools || []).map((tool) => {
      const fn = tool.function || tool;
      const parameters = fn.parameters || tool.parameters || {};
      return [
        fn.name || tool.name || "",
        Array.isArray(parameters.required) ? parameters.required : [],
      ];
    }),
  );

  const _requestSystemText =
    parsed.system ||
    (messages[0] && messages[0].role === "system" ? messages[0].content : "");
  const _requestWorkspaceRootsValue =
    _requestWorkspaceRoots(_requestSystemText);
  const identityKind = parsed.cascadeId ? "native" : "derived";
  const preparedStatus = _prepareAgentStatus({
    key: _conversationKey,
    identityKind,
    identityId: parsed.cascadeId || _conversationKey,
    messages,
    modelUid: modelUid || parsed.modelUid || "",
    provider: target.provider || "",
    upstreamModel: target.model || "",
    workspaceRoots: _requestWorkspaceRootsValue || [],
    injectOutbound: _agentStatusInjectOutbound(target),
    cfg: _cfg,
  });
  messages = preparedStatus.messages;
  const callOpts = {
    messages,
    _agentStatusKey: preparedStatus.state ? preparedStatus.state.key : null,
    _workspaceRoots: _requestWorkspaceRootsValue,
    tools: routeTools,
    toolChoice: parsed.toolChoice,
    maxOutputTokens: target.maxOutputTokens || 32768,
    _promptCacheKey: _conversationKey,
    _disableParallelToolCalls: parsed.disableParallelToolCalls,
    _contextStats,
    _contextMaxTokens,
    _toolOutputStats,
    _toolStrategyStats,
    _workspaceToolStats,
    _localWorkspaceFallback: _localWorkspaceFallbackMode(
      _requestSystemText,
      _requestWorkspaceRootsValue,
      _workspaceToolStats,
    ),
    _allTools: _allRouteTools,
    _requestUsesTools: Array.isArray(parsed.tools) && parsed.tools.length > 0,
    _proxyManagedExecution: _usesProxyManagedExecution(target),
    _lspToolNames, // ★ v9.9.83 · 传递到 _tryRoute → _streamOaToCascade
    _toolAliasMap: null, // ★ v9.9.92 · 修法⑦ · _callProvider 规范化后回填
    _detectedProtocol, // ★ v9.9.99 · 协议类型 → _streamOaToCascade 选择SSE解析器
    _trace: _rt, // ★ 链路追踪 → _tryRoute 内部步骤记录
  };
  if (callOpts._localWorkspaceFallback === "grep-only") {
    _routeDiag(
      `_workspaceFallback: grep-only roots=${callOpts._workspaceRoots.join(" | ")} native=find/read/list local=grep`,
    );
  }

  // ── 检查 provider 是否存在且启用 ──
  // ★ v9.9.73 · builtin-stub 是内建桩 · 不在 _providers 中 · 直接放行到 _tryRoute
  if (target.provider === "builtin-stub") {
    _log(
      "[dao-router] [stub→] " +
        modelUid +
        " → builtin-stub (内建桩 · 跳过provider检查)",
    );
    _routeDiag("route() builtin-stub bypass: modelUid=" + modelUid);
    try {
      const stubOk = await _tryRoute({
        target,
        callOpts,
        res,
        isJSON,
        modelUid,
        isPrimary: true,
        w,
        effectiveModel: _isWildcard ? modelUid : undefined,
      });
      if (stubOk) {
        _stats.routed++;
        if (_rt) _rt.end("ok", "builtin-stub");
        _recordAgentRoute(callOpts, modelUid, {
          provider: "builtin-stub",
          model: "stub-transport-test",
        });
        return true;
      }
    } catch (e) {
      _log("[dao-router] [stub✗] " + modelUid + ": " + e.message);
    }
    _stats.errors++;
    _routeDiag("route() builtin-stub ALL FAIL: " + modelUid);
    if (_rt) _rt.end("failed", "builtin-stub 失败");
    _finishAgentRequest(callOpts._agentStatusKey);
    return false;
  }
  const channelFailures = [];
  const candidates = _buildDispatchCandidates(target, callOpts);
  const routePlan = _dispatchRoutePlan({
    req,
    candidates,
    target,
    callOpts,
    modelUid,
  });
  const preflightLink = _routeDecisionStore
    ? _routeDecisionStore.consumeMatchingPreflight(
        _routePlanMetadata(req, modelUid, callOpts, routePlan),
      )
    : null;
  const routeEvidence = _routeDecisionStore
    ? _routeDecisionStore.beginEvidence(routePlan, preflightLink)
    : null;
  const routingDecision = _recordRoutingDecisionFromPlan(routePlan);
  if (routePlan.budget.status === "strict_rejected") {
    _setRoutingDecisionOutcome(routingDecision, {
      status: "budget_rejected",
      failureClass: "budget",
    });
    if (_routeDecisionStore && routeEvidence) {
      _routeDecisionStore.finishEvidence(routeEvidence.id, {
        status: "budget_rejected",
        failureClass: "budget",
      });
    }
    _stats.errors++;
    _finishAgentRequest(callOpts._agentStatusKey);
    return _errorToCascade(
      res,
      w,
      modelUid,
      isJSON,
      "⚠️ 请求预算超限 (DAO_BUDGET_EXCEEDED · 402)。所有已知渠道的预估成本都高于 $" +
        routePlan.budget.capUsd +
        "；请提高 x-dao-budget-usd、改用 x-dao-budget-fallback: cheapest，或手动调整渠道优先级。",
      { httpStatus: 402 },
    );
  }

  for (const excluded of routePlan.excluded) {
    channelFailures.push({
      provider: excluded.provider,
      model: excluded.model,
      status: 503,
      error: excluded.message,
    });
    if (_rt)
      _rt.step(`skip_${excluded.reason}`, {
        provider: excluded.provider,
        model: excluded.model,
        source: excluded.source,
      });
    if (_routeDecisionStore && routeEvidence) {
      _routeDecisionStore.appendEvidence(routeEvidence.id, {
        kind: "skip",
        provider: excluded.provider,
        model: excluded.model,
        status: 503,
        reason: excluded.reason,
      });
    }
  }

  const plannedCandidates = routePlan.dispatchOrder
    .map((fact) => ({ fact, candidate: candidates[fact.actualPriority - 1] }))
    .filter((entry) => Boolean(entry.candidate));

  let attempted = 0;
  for (const { candidate, fact: candidateFact } of plannedCandidates) {
    const selectedTarget = candidate.target;
    const providerCfg = _providers[selectedTarget.provider];
    if (!providerCfg || providerCfg.enabled === false) {
      channelFailures.push({
        provider: selectedTarget.provider,
        model: selectedTarget.model,
        status: 503,
        error: "渠道已禁用或不存在",
      });
      _routeDiag(
        `route() skip provider=${selectedTarget.provider} source=${candidate.source} disabled=1`,
      );
      if (_rt)
        _rt.step("skip_disabled", {
          provider: selectedTarget.provider,
          model: selectedTarget.model,
          source: candidate.source,
        });
      continue;
    }
    const circuit = _getUpstreamCircuit(
      selectedTarget.provider,
      selectedTarget.model,
    );
    if (circuit) {
      const remainingMs = Math.max(0, circuit.until - Date.now());
      _routeDiag(
        `route() circuit skip provider=${selectedTarget.provider} model=${selectedTarget.model} reason=${circuit.reason} remainingMs=${remainingMs}`,
      );
      if (!callOpts._lastErr) {
        callOpts._lastErr = {
          status: circuit.status || 503,
          provider: selectedTarget.provider,
          body: `circuit open: ${circuit.reason}`,
        };
      }
      channelFailures.push({
        provider: selectedTarget.provider,
        model: selectedTarget.model,
        status: circuit.status || 503,
        error: `熔断中: ${circuit.reason}`,
      });
      if (_rt)
        _rt.step("skip_circuit", {
          provider: selectedTarget.provider,
          model: selectedTarget.model,
          reason: circuit.reason,
          remainingMs,
        });
      continue;
    }

    const isAlternative =
      selectedTarget.provider !== target.provider ||
      selectedTarget.model !== target.model;
    _log(
      `[dao-router] [${isAlternative ? "FB" : "主"}→] ${modelUid} → ${selectedTarget.provider}/${selectedTarget.model} (${candidate.source})`,
    );
    if (_rt)
      _rt.step(isAlternative ? "attempt_fallback" : "attempt", {
        provider: selectedTarget.provider,
        model: selectedTarget.model,
        source: candidate.source,
      });
    try {
      const attemptStartedAt = Date.now();
      // ★ v9.9.430 · retry-before-failover · 先重试当前 provider，真不行再切
      //   道义: 七十六章「柔弱处上」· 瞬时波动先退避重试 · 连续失败才 failover
      //   问题: 原逻辑任何 HTTP 错误 → return false → 主循环立即跳下一个 provider → 抖动
      //   解法: 对 429/5xx/network 先退避重试同 provider N 次 (默认2次=总共3次);
      //         401/余额/404/权限 等硬故障直接 break 跳到 failover。
      const maxSameRetries = _sameProviderMaxRetries(target);
      let ok = false;
      for (let _spr = 0; _spr <= maxSameRetries; _spr++) {
        if (_spr > 0 && res.headersSent) break;
        ok = await _tryRoute({
          target: selectedTarget,
          callOpts,
          res,
          isJSON,
          modelUid,
          isPrimary: attempted === 0,
          w,
          effectiveModel: _isWildcard ? modelUid : undefined,
        });
        if (ok) break;
        const _errStatus =
          (callOpts._lastErr && callOpts._lastErr.status) || 0;
        if (_isHardFailure(_errStatus)) break;
        if (_spr < maxSameRetries && !res.headersSent) {
          const _bo = _resilience
            ? _resilience.calcBackoffMs(_spr)
            : 1000 * (_spr + 1);
          _routeDiag(
            `route() [粘性重试] ${selectedTarget.provider}/${selectedTarget.model} HTTP ${_errStatus} → 退避 ${_bo}ms · 第 ${_spr + 1}/${maxSameRetries} 次 (不切换provider)`,
          );
          if (_rt)
            _rt.step("same_provider_retry", {
              provider: selectedTarget.provider,
              model: selectedTarget.model,
              retry: _spr + 1,
              maxRetries: maxSameRetries,
              backoffMs: _bo,
              status: _errStatus,
            });
          if (
            _resilience &&
            typeof _resilience.sleepBackoff === "function"
          )
            await _resilience.sleepBackoff(_bo);
          else await new Promise((r) => setTimeout(r, _bo));
        }
      }
      attempted++;
      if (_routeDecisionStore && routeEvidence) {
        _routeDecisionStore.appendEvidence(routeEvidence.id, {
          kind: attempted === 1 ? "attempt" : "fallback",
          provider: selectedTarget.provider,
          model: selectedTarget.model,
          status: ok
            ? 200
            : callOpts && callOpts._lastErr && callOpts._lastErr.status,
          durationMs: Date.now() - attemptStartedAt,
          reason: ok
            ? null
            : _routingFailureClass(callOpts && callOpts._lastErr),
        });
      }
      if (ok) {
        const protocolDecision = _resolveTargetProtocolDecision(
          selectedTarget,
          _providers[selectedTarget.provider] || {},
          selectedTarget.model,
        );
        _setRoutingDecisionOutcome(routingDecision, {
          status: "selected",
          target: selectedTarget,
        });
        _routeRuntime.set(normalized, {
          state: "active",
          modelUid,
          provider: selectedTarget.provider,
          model: selectedTarget.model,
          protocol: protocolDecision.protocol,
          configuredProtocol: protocolDecision.configuredProtocol,
          actualProtocol: protocolDecision.protocol,
          protocolAdjusted: protocolDecision.adjusted,
          protocolReason: protocolDecision.reason,
          protocolSource: protocolDecision.source,
          reasoningLevel:
            selectedTarget.reasoningLevel ||
            selectedTarget.reasoningEffort ||
            "default",
          source: candidate.source,
          channelStrategy: _channelStrategy(target),
          fallback: isAlternative,
          updatedAt: new Date().toISOString(),
        });
        if (target && (target._customModel || target._customModelId)) {
          _customModelRuntime.set(target._customModelId || modelUid, {
            state: "active",
            provider: selectedTarget.provider,
            model: selectedTarget.model,
            source: candidate.source,
            configuredProtocol: protocolDecision.configuredProtocol,
            actualProtocol: protocolDecision.protocol,
            protocolAdjusted: protocolDecision.adjusted,
            protocolReason: protocolDecision.reason,
            protocolSource: protocolDecision.source,
            channelStrategy: _channelStrategy(target),
            updatedAt: new Date().toISOString(),
          });
        }
        if (isAlternative) {
          _stats.errorFallback++;
          _stats.fallbackRouted++;
        } else _stats.routed++;
        if (isAlternative || _channelStrategy(target) === "random") {
          _rememberConversationProvider(target, callOpts, selectedTarget);
        } else {
          _forgetConversationProvider(target, callOpts);
        }
        if (_rt)
          _rt.end(
            "ok",
            `${selectedTarget.provider}/${selectedTarget.model} (${candidate.source})`,
          );
        // ★ OmniRoute 借鉴: 记录成功指标供评分器使用
        if (_channelScorer) {
          try {
            _channelScorer.recordSuccess(
              selectedTarget.provider,
              selectedTarget.model,
              callOpts._ttfbMs,
              callOpts._totalMs,
            );
          } catch (_) {}
        }
        _recordAgentRoute(callOpts, modelUid, selectedTarget);
        if (_routeDecisionStore && routeEvidence) {
          _routeDecisionStore.finishEvidence(routeEvidence.id, {
            status: "selected",
            provider: selectedTarget.provider,
            model: selectedTarget.model,
            actualPriority: candidateFact.actualPriority,
          });
        }
        return true;
      }
      if (callOpts && callOpts._lastErr) {
        channelFailures.push({
          provider: selectedTarget.provider,
          model: selectedTarget.model,
          status: callOpts._lastErr.status || 0,
          error: String(callOpts._lastErr.body || "请求失败").slice(0, 500),
        });
        // ★ OmniRoute 借鉴: 记录失败指标供评分器使用
        if (_channelScorer) {
          try {
            _channelScorer.recordFailure(
              selectedTarget.provider,
              selectedTarget.model,
              callOpts._lastErr.status || 0,
            );
          } catch (_) {}
        }
        if (_rt)
          _rt.step("attempt_failed", {
            provider: selectedTarget.provider,
            model: selectedTarget.model,
            status: callOpts._lastErr.status || 0,
            error: String(callOpts._lastErr.body || "").slice(0, 200),
          });
      }
      if (_isStickySource(candidate.source)) {
        if (
          _getUpstreamCircuit(selectedTarget.provider, selectedTarget.model)
        ) {
          _forgetConversationProvider(target, callOpts);
        }
      }
    } catch (e) {
      attempted++;
      if (_routeDecisionStore && routeEvidence) {
        _routeDecisionStore.appendEvidence(routeEvidence.id, {
          kind: attempted === 1 ? "attempt" : "fallback",
          provider: selectedTarget.provider,
          model: selectedTarget.model,
          reason: "transport",
        });
      }
      if (_isStickySource(candidate.source)) {
        if (
          _getUpstreamCircuit(selectedTarget.provider, selectedTarget.model)
        ) {
          _forgetConversationProvider(target, callOpts);
        }
      }
      _log(
        `[dao-router] [✗] ${candidate.source} ${selectedTarget.provider}/${selectedTarget.model}: ${e.message}`,
      );
      channelFailures.push({
        provider: selectedTarget.provider,
        model: selectedTarget.model,
        status: 0,
        error: e.message,
      });
      if (_rt)
        _rt.step("attempt_exception", {
          provider: selectedTarget.provider,
          model: selectedTarget.model,
          error: e.message,
        });
      if (_failureStats)
        _failureStats.record(selectedTarget.provider, selectedTarget.model, {
          status: 0,
          error: e.message,
        });
      // 网络重置、超时、协议解析等异常也必须进入质量评分，避免坏渠道被持续选中。
      if (_channelScorer) {
        try {
          _channelScorer.recordFailure(
            selectedTarget.provider,
            selectedTarget.model,
            0,
          );
        } catch (_) {}
      }
    }
  }

  // ── 全部失败 → 返回 false (由 source.js 直接报错 · 不回退官方) ──
  _setRoutingDecisionOutcome(routingDecision, {
    status: "exhausted",
    failureCount: channelFailures.length,
    failureClass: _routingFailureClass(
      channelFailures[channelFailures.length - 1],
    ),
  });
  if (_routeDecisionStore && routeEvidence) {
    _routeDecisionStore.finishEvidence(routeEvidence.id, {
      status: "exhausted",
      failureClass: _routingFailureClass(
        channelFailures[channelFailures.length - 1],
      ),
    });
  }
  _stats.errors++;
  _routeRuntime.set(normalized, {
    state: "failed",
    modelUid,
    failures: channelFailures,
    updatedAt: new Date().toISOString(),
  });
  _log(`[dao-router] [✗] ${modelUid} 所有路由失败 · 不回退官方`);
  _routeDiag(`route() ALL FAIL: ${modelUid} headersSent=${res.headersSent}`);
  if (_rt)
    _rt.end(
      "failed",
      `全部 ${channelFailures.length} 个渠道失败: ${channelFailures.map((f) => `${f.provider}(${f.status})`).join(", ")}`,
    );
  if (_alertCenter)
    _alertCenter.push({
      level: "error",
      type: "route_failed",
      title: `模型 ${modelUid} 全部路由失败`,
      detail: channelFailures
        .map((f) => `${f.provider}/${f.model} → ${f.status}: ${f.error}`)
        .join(" | ")
        .slice(0, 500),
      model: modelUid,
    });
  if (target && (target._customModel || target._customModelId)) {
    _customModelRuntime.set(target._customModelId || modelUid, {
      state: "failed",
      failures: channelFailures,
      updatedAt: new Date().toISOString(),
    });
    try {
      process.emit("dao:custom-model-channels-failed", {
        modelUid,
        customModelId: target._customModelId || modelUid,
        channels: _configuredChannelTargets(target),
        failures: channelFailures,
        at: new Date().toISOString(),
      });
    } catch {}
  }

  _finishAgentRequest(callOpts._agentStatusKey);

  // ★ v9.9.288 · 反者道之动 · 上游错误可读回传 (不再对话死亡)
  //   若全部路由因上游 4xx/5xx 失败且响应头未发出 → 合成可读错误帧回传 Cascade ·
  //   让用户看到明确原因(如 413 请求过大)而非无尽等待。
  if (!res.headersSent && callOpts && callOpts._lastErr) {
    const _e = callOpts._lastErr;
    const _txt = _humanUpstreamError(_e.status, _e.provider, _e.body);
    const _sent = await _errorToCascade(res, w, modelUid, isJSON, _txt);
    if (_sent) {
      _log(
        `[dao-router] [↩] ${modelUid} 上游错误已可读回传 Cascade (HTTP ${_e.status} · ${_e.provider})`,
      );
      return true;
    }
  }
  return false;
}

// ★ v9.9.308 · 首字守望 · 冷启/长空闲后首请的「吞言」根治
//   现象: 空闲后第一条消息上游返回 200，但响应体迟迟无字节(半开/冷连 socket 静默卡死)，
//        Cascade 端死等 → 用户感觉「首条被吞」，重发第二条(新连接)即成功。
//   守望: 上游 200 后在 _TTFB_FIRSTBYTE_MS 内若无首字节，则判为卡死，透明重试一次。
let _TTFB_FIRSTBYTE_MS = parseInt(process.env.DAO_TTFB_MS || "120000", 10);
if (!(_TTFB_FIRSTBYTE_MS > 0)) _TTFB_FIRSTBYTE_MS = 120000;

/**
 * 等上游响应体「首字节」到达，不消费数据(用 readable+read+unshift 把首块还回去)。
 * @returns {Promise<"data"|"end"|"error"|"timeout">}
 */
function _awaitFirstByte(stream, ms) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      stream.removeListener("readable", onR);
      stream.removeListener("end", onE);
      stream.removeListener("error", onErr);
      resolve(v);
    };
    const onR = () => {
      const chunk = stream.read();
      if (chunk === null) return; // readable 误触(无实数据) → 继续等
      stream.unshift(chunk); // 首块还回缓冲，交由 _streamOaToCascade 正常消费
      fin("data");
    };
    const onE = () => fin("end");
    const onErr = () => fin("error");
    const t = setTimeout(() => fin("timeout"), ms);
    stream.on("readable", onR);
    stream.once("end", onE);
    stream.once("error", onErr);
  });
}

function _beginProviderAttempt(callOpts) {
  if (!callOpts || typeof callOpts !== "object") return 0;
  const now = Date.now();
  if (!callOpts._requestStartedAt) callOpts._requestStartedAt = now;
  callOpts._attemptStartedAt = now;
  callOpts._attemptCount = Math.max(0, Number(callOpts._attemptCount) || 0) + 1;
  if (!callOpts._firstAttemptStartedAt) callOpts._firstAttemptStartedAt = now;
  callOpts._daoDispatchMs = Math.max(
    0,
    callOpts._firstAttemptStartedAt - callOpts._requestStartedAt,
  );
  return now;
}

function _observeProviderHeader(callOpts) {
  if (!callOpts || !callOpts._attemptStartedAt) return;
  callOpts._upstreamHeaderMs = Math.max(
    0,
    Date.now() - callOpts._attemptStartedAt,
  );
}

function _markFirstVisible(callOpts, kind) {
  if (!callOpts || callOpts._firstVisibleAt || !callOpts._attemptStartedAt)
    return;
  const now = Date.now();
  callOpts._firstVisibleAt = now;
  callOpts._firstSignalKind = kind === "tool" ? "tool" : "text";
  callOpts._ttfbMs = Math.max(0, now - callOpts._requestStartedAt);
  callOpts._upstreamSemanticMs = Math.max(0, now - callOpts._attemptStartedAt);
  callOpts._retryOverheadMs = Math.max(
    0,
    callOpts._ttfbMs -
      (Number(callOpts._daoDispatchMs) || 0) -
      callOpts._upstreamSemanticMs,
  );
}

function _finishLatencyObservation(callOpts) {
  if (!callOpts || !callOpts._requestStartedAt) return;
  callOpts._totalMs = Math.max(0, Date.now() - callOpts._requestStartedAt);
  const observation = callOpts._cacheObservation;
  if (!observation || typeof observation !== "object") return;
  Object.assign(observation, {
    ttftMs: callOpts._firstVisibleAt ? callOpts._ttfbMs : null,
    ttftObserved: !!callOpts._firstVisibleAt,
    daoDispatchMs: Number.isFinite(callOpts._daoDispatchMs)
      ? callOpts._daoDispatchMs
      : null,
    upstreamHeaderMs: Number.isFinite(callOpts._upstreamHeaderMs)
      ? callOpts._upstreamHeaderMs
      : null,
    upstreamSemanticMs: Number.isFinite(callOpts._upstreamSemanticMs)
      ? callOpts._upstreamSemanticMs
      : null,
    retryOverheadMs: Number.isFinite(callOpts._retryOverheadMs)
      ? callOpts._retryOverheadMs
      : null,
    durationMs: callOpts._totalMs,
    attemptCount: Math.max(1, Number(callOpts._attemptCount) || 1),
    firstSignalKind: callOpts._firstSignalKind || "none",
    success: !!callOpts._firstVisibleAt,
  });
}

/** 尝试单条路由 */
async function _tryRoute({
  target,
  callOpts,
  res,
  isJSON,
  modelUid,
  isPrimary,
  w,
  effectiveModel, // ★ 通配符时用原始 modelUid 替代 target.model
}) {
  if (callOpts && !callOpts._requestStartedAt)
    callOpts._requestStartedAt = Date.now();
  // ★ v9.9.73 · 内建桩: builtin-stub → 零依赖传输层验证
  //   不调 _callProvider · 不做健康检查 · 不假外求
  //   道义: 三十九章「侯王得一以为天下正」· 得一则正
  if (target.provider === "builtin-stub") {
    _log("[dao-router] [stub→] " + modelUid + " → builtin-stub (传输层验证)");
    _routeDiag(
      "_tryRoute builtin-stub: modelUid=" +
        modelUid +
        " msgs=" +
        (callOpts.messages || []).length +
        " tools=" +
        (callOpts.tools || []).length,
    );
    try {
      const ok = await _stubToCascade(
        res,
        w,
        modelUid,
        callOpts.messages,
        callOpts.tools,
        isJSON,
      );
      return ok;
    } catch (e) {
      _log("[dao-router] [stub✗] " + modelUid + ": " + e.message);
      _routeDiag("_tryRoute builtin-stub EXCEPTION: " + e.message);
      return false;
    }
  }

  const provCfg = _providers[target.provider] || {};
  const tag = isPrimary ? "" : "[备]";
  const sendModel = effectiveModel || target.model;

  // ★ v9.9.62 · DEFECT12 修复: 恢复健康检查 (devindao /admin/health 已可用)
  if (isPrimary && provCfg.healthCheck) {
    // ★ v9.9.58 · 相对路径拼接 baseUrl · 道法自然
    let hcUrl = provCfg.healthCheck;
    if (hcUrl.startsWith("/")) {
      const base = provCfg.baseUrl || _gatewayUrl;
      try {
        const baseU = new URL(base);
        hcUrl = `${baseU.protocol}//${baseU.hostname}:${baseU.port || (baseU.protocol === "https:" ? "443" : "80")}${hcUrl}`;
      } catch {
        hcUrl = `http://127.0.0.1:7788${hcUrl}`;
      }
    }
    const alive = await _checkHealth(target.provider, hcUrl);
    if (!alive) {
      _log(
        `[dao-router] ${tag}[SKIP] ${target.provider} 健康检查失败 · ${modelUid} · url=${hcUrl}`,
      );
      return false;
    }
  }

  _log(`[dao-router] ${tag}[→] ${modelUid} → ${target.provider}/${sendModel}`);
  try {
    // ★ v9.9.308 · 首字守望重试环 · 主路/流式/未下发头时，上游200但体无流则透明重试一次
    let agRes;
    let _ttfbRetried = false;
    let _promptCacheKeyRetried = false;
    let _cacheHintRetried = false;
    let _reasoningParamRetried = false;
    let _encryptedReasoningRetried = false;
    while (true) {
      _beginProviderAttempt(callOpts);
      agRes = await _callProvider(
        provCfg,
        target.provider,
        sendModel,
        callOpts.messages,
        callOpts.tools,
        callOpts.toolChoice,
        callOpts.maxOutputTokens,
        target, // ★ v9.9.80 · 传入路由配置 (含 thinkingEnabled)
        callOpts._lspToolNames, // ★ v9.9.83 · LSP 原始工具名集合
        callOpts, // ★ v9.9.92 · 修法⑦ · 回填 _toolAliasMap
      );
      _observeProviderHeader(callOpts);

      if (agRes.statusCode !== 200) {
        const errBody = await _readAll(agRes);
        if (
          !_cacheHintRetried &&
          _promptCachePolicy &&
          callOpts &&
          callOpts._promptCachePlan
        ) {
          const cacheRetry = _promptCachePolicy.observeFailure({
            providerId: callOpts._promptCachePlan.providerId,
            protocol: callOpts._promptCachePlan.protocol,
            status: agRes.statusCode,
            body: errBody,
          });
          if (cacheRetry.retry) {
            _cacheHintRetried = true;
            _routeDiag(
              `_tryRoute cache hint unsupported → transparent downgrade feature=${cacheRetry.feature} provider=${target.provider}`,
            );
            if (callOpts._trace) {
              callOpts._trace.step("retry_cache_downgrade", {
                provider: target.provider,
                status: agRes.statusCode,
                feature: cacheRetry.feature,
              });
            }
            continue;
          }
        }
        if (
          !_promptCacheKeyRetried &&
          _isPromptCacheKeyUnsupportedResponse(agRes.statusCode, errBody)
        ) {
          _promptCacheKeyRetried = true;
          _promptCacheKeyUnsupported.add(
            _promptCacheProviderId(target.provider, provCfg),
          );
          callOpts._disablePromptCacheKey = true;
          _routeDiag(
            `_tryRoute prompt_cache_key unsupported → transparent retry without key provider=${target.provider}`,
          );
          if (callOpts._trace)
            callOpts._trace.step("retry_no_cache_key", {
              provider: target.provider,
              status: agRes.statusCode,
            });
          continue;
        }
        if (
          !_encryptedReasoningRetried &&
          _isEncryptedReasoningUnsupportedResponse(agRes.statusCode, errBody)
        ) {
          _encryptedReasoningRetried = true;
          callOpts._disableEncryptedReasoning = true;
          _routeDiag(
            `_tryRoute encrypted reasoning unsupported → transparent retry without encrypted continuation provider=${target.provider}`,
          );
          if (callOpts._trace)
            callOpts._trace.step("retry_no_encrypted_reasoning", {
              provider: target.provider,
              status: agRes.statusCode,
            });
          continue;
        }
        if (
          !_reasoningParamRetried &&
          _isReasoningParamUnsupportedResponse(agRes.statusCode, errBody)
        ) {
          _reasoningParamRetried = true;
          callOpts._disableReasoningParams = true;
          _routeDiag(
            `_tryRoute reasoning parameter unsupported → transparent retry without reasoning fields provider=${target.provider}`,
          );
          if (callOpts._trace)
            callOpts._trace.step("retry_no_reasoning_params", {
              provider: target.provider,
              status: agRes.statusCode,
            });
          continue;
        }
        _log(
          `[dao-router] ${tag}[✗] HTTP ${agRes.statusCode}: ${errBody.slice(0, 180)}`,
        );
        _routeDiag(
          `_tryRoute ${tag} HTTP ${agRes.statusCode}: ${errBody.slice(0, 200)} model=${sendModel}`,
        );
        const circuit = _openUpstreamCircuit(
          target.provider,
          sendModel,
          agRes.statusCode,
          errBody,
          agRes.headers,
        );
        if (circuit) {
          _routeDiag(
            `_tryRoute circuit open provider=${target.provider} model=${circuit.model} reason=${circuit.reason} ttlMs=${Math.max(0, circuit.until - Date.now())}`,
          );
        }
        if (callOpts._trace)
          callOpts._trace.step("http_error", {
            provider: target.provider,
            model: sendModel,
            status: agRes.statusCode,
            error: errBody.slice(0, 200),
            circuitOpened: !!circuit,
          });
        // 失败模式入账 (熔断已在 _openUpstreamCircuit 内记 · 此处补未熔断的失败)
        if (_failureStats && !circuit)
          _failureStats.record(target.provider, sendModel, {
            status: agRes.statusCode,
            error: errBody.slice(0, 200),
          });
        if (isPrimary && agRes.statusCode >= 500) {
          _healthCache[target.provider] = { alive: false, ts: Date.now() };
        }
        // ★ v9.9.288 · 记录上游错误 · 供 route() ALL-FAIL 时可读回传 Cascade
        if (callOpts) {
          callOpts._lastErr = {
            status: agRes.statusCode,
            provider: target.provider,
            body: errBody.slice(0, 300),
          };
        }
        return false;
      }

      // ★ v9.9.308 · 首字守望: 上游已200但响应体在 _TTFB_FIRSTBYTE_MS 内无首字
      //   → 判为冷连/半开 socket 静默卡死 → 销毁本连、透明重试一次(新连接)，
      //   仅主路·仅流式·仅未下发下游头时生效，避免「首条被吞、需重发」。
      if (
        isPrimary &&
        !res.headersSent &&
        provCfg.streamMode !== "unary" &&
        !_ttfbRetried
      ) {
        const _fb = await _awaitFirstByte(agRes, _TTFB_FIRSTBYTE_MS);
        if (_fb === "timeout") {
          _ttfbRetried = true;
          _routeDiag(
            `_tryRoute ${tag} TTFB stall ${_TTFB_FIRSTBYTE_MS}ms 无首字 → 透明重试 ${target.provider}/${sendModel}`,
          );
          if (callOpts._trace)
            callOpts._trace.step("retry_ttfb_stall", {
              provider: target.provider,
              model: sendModel,
              waitedMs: _TTFB_FIRSTBYTE_MS,
            });
          try {
            agRes.destroy();
          } catch {}
          continue;
        }
      }
      break;
    }

    if (!res.headersSent) {
      // ★ v9.9.73e · 与官方 API 响应头完全对齐
      //   实证: 官方 API 返回 content-type=application/connect+proto + connect-accept-encoding=gzip
      //   道义: 执今之道以御今之有 · 与官方一致方能通
      res.writeHead(200, {
        "content-type": isJSON
          ? "application/connect+json"
          : "application/connect+proto",
        "connect-accept-encoding": "gzip",
      });
    }
    _routeDiag(
      `_tryRoute ${tag} writeHead(200) streamMode=${provCfg.streamMode || "stream"} model=${sendModel}`,
    );
    // ★ v9.9.83 · 传递 lspToolNames 到流式/非流式转换
    // ★ v9.9.92 · 修法⑦ · 传递 _toolAliasMap 到流式/非流式转换 · 工具名反规范化
    // ★ v9.9.99 · 传递 protocol 到流式/非流式转换 · 多协议SSE解析
    const _lspTN = callOpts._lspToolNames;
    const _tam = callOpts._toolAliasMap || null;
    const _protocol =
      callOpts._detectedProtocol || provCfg.protocol || "openai-chat";
    let streamResult = await (provCfg.streamMode === "unary"
      ? _unaryOaToCascade(
          agRes,
          res,
          w,
          modelUid,
          _lspTN,
          _tam,
          _protocol,
          callOpts,
        )
      : _streamOaToCascade(
          agRes,
          res,
          w,
          modelUid,
          _lspTN,
          _tam,
          _protocol,
          callOpts._localWorkspaceFallback,
          callOpts,
        ));

    // Some Responses gateways return HTTP 200 with an empty SSE stream after
    // a tool result. Retry once while the downstream Connect stream is open.
    if (
      streamResult &&
      streamResult.emptyResponse &&
      provCfg.streamMode !== "unary"
    ) {
      _routeDiag(
        `_tryRoute empty upstream response: retry once provider=${target.provider} model=${sendModel}`,
      );
      let emptyRetryRes;
      try {
        _beginProviderAttempt(callOpts);
        emptyRetryRes = await _callProvider(
          provCfg,
          target.provider,
          sendModel,
          callOpts.messages,
          callOpts.tools,
          callOpts.toolChoice,
          callOpts.maxOutputTokens,
          target,
          callOpts._lspToolNames,
          callOpts,
        );
        _observeProviderHeader(callOpts);
      } catch (error) {
        _routeDiag(`_tryRoute empty response retry failed: ${error.message}`);
      }
      if (emptyRetryRes && emptyRetryRes.statusCode === 200) {
        streamResult = await _streamOaToCascade(
          emptyRetryRes,
          res,
          w,
          modelUid,
          _lspTN,
          _tam,
          _protocol,
          callOpts._localWorkspaceFallback,
          callOpts,
        );
        _routeDiag(
          `_tryRoute empty response retry result: empty=${!!(streamResult && streamResult.emptyResponse)} text=${(streamResult && streamResult.textBytes) || 0} tools=${(streamResult && streamResult.toolCount) || 0}`,
        );
      }
    }
    if (streamResult && streamResult.emptyResponse) {
      callOpts._lastErr = {
        status: 502,
        provider: target.provider,
        body: "upstream returned an empty Responses stream after retry",
      };
      _routeDiag(
        "_tryRoute empty response persisted after retry: keep downstream open for fallback",
      );
      return false;
    }

    // ★ v9.9.86 · 服务端工具内部重试 (大制无割版)
    //   当 DeepSeek 调用了服务端工具 (trajectory_search 等) 时:
    //   1. _streamOaToCascade 已拦截 → 缓冲帧被丢弃 → 流保持打开
    //   2. 代理层执行工具 → 生成 tool result
    //   3. 将 assistant tool_calls (含 thinking + text) + tool result 追加到 messages
    //   4. 内部重试请求 DeepSeek → 流式转发新响应到同一个 res
    //   5. LSP 只看到最终的文本回复 → 完全无感
    //   道义: 十七章「太上不知有之」· LSP 不知有服务端工具调用
    //   限制: 最多重试 3 次 → 防止无限循环
    if (
      streamResult &&
      streamResult.serverSideCalls &&
      streamResult.serverSideCalls.length > 0
    ) {
      const _MAX_RETRIES = 3;
      let _retryCount = 0;
      let _currentMessages = callOpts.messages; // 原始 messages (已转为 OA 格式)
      let _remainingServerCalls = streamResult.serverSideCalls;
      let _lastRetryResult = null;
      let _pendingLocalTranscriptMessages = [];
      // ★ v9.9.86 · 保留第一轮的 thinking + text 内容
      let _prevTextAccum = streamResult.textAccum || "";
      let _prevThinkAccum = streamResult.thinkAccum || "";

      // Devin owns Fast Context execution. Never hold a native code_search
      // frame behind a proxy-local Grep continuation: if it is not emitted in
      // this response, Cascade can mark the original native step as Skipped.
      const _nativeLspCalls = streamResult.lspSideCalls || [];
      const _yieldNativeLspCalls =
        callOpts._localWorkspaceFallback === "grep-only" &&
        _nativeLspCalls.length > 0 &&
        _remainingServerCalls.every((tc) =>
          _grepOnlyLocalWorkspaceToolNames.has(String(tc.name || "")),
        );

      if (_yieldNativeLspCalls) {
        const _toolResults = await Promise.all(
          _remainingServerCalls.map(async (tc) => ({
            tool_call_id: tc.id,
            content: tc.validationError
              ? tc.validationError
              : _isWinTool(tc.name)
                ? await _winTools.execute(tc.name, tc.argumentsJson)
                : _executeServerTool(tc.name, tc.argumentsJson, callOpts),
          })),
        );
        const _localAssistantMessage = {
          role: "assistant",
          content: "",
          reasoning_content: "",
          tool_calls: _remainingServerCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.argumentsJson },
          })),
        };
        const _localToolMessages = _toolResults.map((tr) => ({
          role: "tool",
          tool_call_id: tr.tool_call_id,
          content: tr.content,
        }));

        for (let index = 0; index < _toolResults.length; index++) {
          const visibleResult = _formatVisibleLocalGrepResult(
            _remainingServerCalls[index] && _remainingServerCalls[index].name,
            _toolResults[index] && _toolResults[index].content,
            _remainingServerCalls[index] &&
              _remainingServerCalls[index].argumentsJson,
          );
          if (!visibleResult) continue;
          const visibleMessageId = Date.now() + index;
          const visibleFrame = w.buildFrame(
            0,
            Buffer.concat([
              w.buildFrameHeader(visibleMessageId, visibleMessageId),
              w.encodeString(w.RSP.DELTA_TEXT, visibleResult),
            ]),
          );
          if (visibleFrame && visibleFrame.length && !res.writableEnded) {
            res.write(visibleFrame);
          }
        }
        _rememberLocalToolTranscript(
          callOpts._promptCacheKey,
          [_localAssistantMessage, ..._localToolMessages],
          _nativeLspCalls.map((tc) => tc.id),
        );
        _routeDiag(
          `_workspaceFallback native-lsp-priority: local=${_remainingServerCalls.map((tc) => tc.name).join(",")} native=${_nativeLspCalls.map((tc) => tc.name).join(",")}`,
        );
        _remainingServerCalls = [];
        _lastRetryResult = { streamFinalized: false, stopReason: w.STOP_END };
      }

      while (_remainingServerCalls.length > 0 && _retryCount < _MAX_RETRIES) {
        _retryCount++;
        _log(
          `[dao-router] ⚡ 内部重试 #${_retryCount}: ${_remainingServerCalls.length} 个服务端工具`,
        );
        _routeDiag(
          `_tryRoute internal retry #${_retryCount}: serverSideCalls=${_remainingServerCalls.length} names=${_remainingServerCalls.map((c) => c.name).join(",")}`,
        );

        // 执行服务端工具 → 生成 tool result (Windows 原生工具走异步桥执行)
        const _toolResults = await Promise.all(
          _remainingServerCalls.map(async (tc) => ({
            tool_call_id: tc.id,
            content: tc.validationError
              ? tc.validationError
              : _isWinTool(tc.name)
                ? await _winTools.execute(tc.name, tc.argumentsJson)
                : _executeServerTool(tc.name, tc.argumentsJson, callOpts),
          })),
        );

        // ★ v9.9.86 · 追加 assistant 消息: 保留 thinking + text 内容
        //   DeepSeek 要求 assistant 消息的 reasoning_content 和 content
        //   必须与实际产生的一致 → 否则 400 错误
        //   道义: 二十八章「大制无割」· 消息序列完整方能通
        // ★ v9.9.87 · 合并所有工具调用 (服务端 + LSP)
        //   DeepSeek 要求 assistant 消息的 tool_calls 包含所有调用的工具
        //   如果只包含服务端工具 → DeepSeek 认为未调用 LSP 工具 → 重复调用
        //   道义: 二十八章「大制无割」· 完整方能通
        const _allToolCalls = [
          ..._remainingServerCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.argumentsJson },
          })),
          ...(streamResult.lspSideCalls || []).map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.argumentsJson || "{}" },
          })),
        ];

        const _localGrepRetry =
          callOpts._localWorkspaceFallback === "grep-only" &&
          _remainingServerCalls.every((tc) =>
            _grepOnlyLocalWorkspaceToolNames.has(String(tc.name || "")),
          );
        if (_localGrepRetry) {
          _routeDiag(
            `_tryRoute local grep retry: discard transient assistant text=${_prevTextAccum.length}B thinking=${_prevThinkAccum.length}B`,
          );
          for (let index = 0; index < _toolResults.length; index++) {
            const visibleResult = _formatVisibleLocalGrepResult(
              _remainingServerCalls[index] && _remainingServerCalls[index].name,
              _toolResults[index] && _toolResults[index].content,
              _remainingServerCalls[index] &&
                _remainingServerCalls[index].argumentsJson,
            );
            if (!visibleResult) continue;
            const visibleMessageId = Date.now() + index;
            const visibleFrame = w.buildFrame(
              0,
              Buffer.concat([
                w.buildFrameHeader(visibleMessageId, visibleMessageId),
                w.encodeString(w.RSP.DELTA_TEXT, visibleResult),
              ]),
            );
            if (visibleFrame && visibleFrame.length && !res.writableEnded) {
              res.write(visibleFrame);
            }
            _routeDiag(
              `_localToolTranscript visible name=${_remainingServerCalls[index] && _remainingServerCalls[index].name} bytes=${Buffer.byteLength(visibleResult)}`,
            );
          }
        }
        const _assistantToolMessage = {
          role: "assistant",
          content: _localGrepRetry ? "" : _prevTextAccum || "",
          reasoning_content: _localGrepRetry ? "" : _prevThinkAccum || "",
          tool_calls: _allToolCalls,
        };
        _currentMessages = [..._currentMessages, _assistantToolMessage];

        // 追加 tool result 消息 (服务端工具)
        const _serverToolMessages = [];
        for (const tr of _toolResults) {
          const _toolMessage = {
            role: "tool",
            tool_call_id: tr.tool_call_id,
            content: tr.content,
          };
          _serverToolMessages.push(_toolMessage);
          _currentMessages.push(_toolMessage);
        }

        // ★ v9.9.87 · 追加 LSP 工具的占位 tool result
        //   如果第一轮同时有 SERVER + LSP 工具调用, LSP 工具也需要 tool result
        //   否则 DeepSeek 会报错: assistant 有 tool_calls 但缺少对应的 tool result
        //   占位结果告诉 DeepSeek 该工具暂不可用 → 重试时不再调用
        //   道义: 二十八章「大制无割」· 消息序列完整方能通
        const _lspSideCalls = streamResult.lspSideCalls || [];
        const _lspPlaceholderMessages = [];
        for (const tc of _lspSideCalls) {
          const _placeholderMessage = {
            role: "tool",
            tool_call_id: tc.id,
            content: `[LSP tool ${tc.name} not executed in proxy retry - will be re-invoked in next response]`,
          };
          _lspPlaceholderMessages.push(_placeholderMessage);
          _currentMessages.push(_placeholderMessage);
        }
        if (_localGrepRetry) {
          _pendingLocalTranscriptMessages.push(
            _assistantToolMessage,
            ..._serverToolMessages,
            ..._lspPlaceholderMessages,
          );
        }

        const _forceFinalSynthesis = _retryCount >= _MAX_RETRIES;
        const _retryTools = _forceFinalSynthesis
          ? _filterRetryTools(callOpts.tools)
          : _localGrepRetry
            ? (callOpts.tools || []).filter(
                (tool) =>
                  !/^(?:CodeSearch|code_search|SmartReading|smart_reading)$/i.test(
                    _toolFunctionName(tool),
                  ),
              )
            : callOpts.tools;
        const _hasRetryTools =
          Array.isArray(_retryTools) && _retryTools.length > 0;
        if (_forceFinalSynthesis) {
          _currentMessages.push({
            role: "user",
            content:
              "The proxy-local search/tool retry limit has been reached. Do not repeat proxy-local search helpers such as CodeSearch, Grep, or FindByName. Continue using the remaining client tools (for example read_file, edit, write_to_file, multi_edit, or run_command) when they are needed. If the task requires changes, make and verify those changes before giving a summary. Do not return a plan or status report while actionable work remains.",
          });
        }

        // ★ 修复消息序列: 确保不以 tool 消息结尾
        _currentMessages = _fixOAMessages(_currentMessages);

        // ★ v9.9.87 · 心跳帧: 内部重试期间发送 thinking 帧 · 防止 LSP 超时 abort
        //   道义: 五章「虚而不淈 踵而俞出」· 流不塞则通 · 心跳不息则连接不竭
        //   LSP 客户端约 10 秒无数据则 abort → 重试调用可能耗时 10+ 秒
        //   发送 thinking 帧让 LSP 知道连接仍活跃
        try {
          const _hbMsgId = Date.now();
          const _hbHdrBuf = w.buildFrameHeader(_hbMsgId, _hbMsgId);
          const _hbParts = [_hbHdrBuf];
          const _hbFr = w.buildFrame(0, Buffer.concat(_hbParts));
          if (_hbFr && _hbFr.length && !res.writableEnded) {
            res.write(_hbFr);
            _routeDiag(
              `_tryRoute heartbeat #${_retryCount}: metadata-only keepalive`,
            );
          }
        } catch (_hbErr) {
          _routeDiag(
            `_tryRoute heartbeat #${_retryCount} FAILED: ${_hbErr.message}`,
          );
        }

        // ★ v9.9.87 · 心跳定时器: 重试调用期间每 5 秒发送一次 thinking 帧
        //   防止 DeepSeek 响应慢时 LSP 超时
        const _heartbeatInterval = setInterval(() => {
          try {
            const _hb2MsgId = Date.now();
            const _hb2HdrBuf = w.buildFrameHeader(_hb2MsgId, _hb2MsgId);
            const _hb2Parts = [_hb2HdrBuf];
            const _hb2Fr = w.buildFrame(0, Buffer.concat(_hb2Parts));
            if (_hb2Fr && _hb2Fr.length && !res.writableEnded) {
              res.write(_hb2Fr);
              _routeDiag(`_tryRoute heartbeat tick #${_retryCount}: keepalive`);
            }
          } catch {}
        }, 5000);

        // 重新请求 DeepSeek
        let retryRes;
        try {
          _beginProviderAttempt(callOpts);
          retryRes = await _callProvider(
            provCfg,
            target.provider,
            sendModel,
            _currentMessages,
            _forceFinalSynthesis
              ? _hasRetryTools
                ? _retryTools
                : null
              : callOpts.tools,
            _forceFinalSynthesis
              ? _hasRetryTools
                ? "auto"
                : "none"
              : callOpts.toolChoice,
            callOpts.maxOutputTokens,
            target,
            callOpts._lspToolNames,
            _forceFinalSynthesis
              ? {
                  ...callOpts,
                  _allTools: _hasRetryTools ? _retryTools : [],
                  _forceNoTools: !_hasRetryTools,
                  _suppressProxyTools: true,
                }
              : callOpts, // ★ v9.9.92 · 修法⑦ · 回填 _toolAliasMap
          );
          _observeProviderHeader(callOpts);
        } finally {
          // ★ 无论成功失败都停止心跳定时器
          clearInterval(_heartbeatInterval);
        }

        if (retryRes.statusCode !== 200) {
          const errBody = await _readAll(retryRes);
          _log(
            `[dao-router] ⚡ 内部重试 HTTP ${retryRes.statusCode}: ${errBody.slice(0, 180)}`,
          );
          break;
        }

        // 流式转发重试响应到同一个 res
        _lastRetryResult = await (provCfg.streamMode === "unary"
          ? _unaryOaToCascade(
              retryRes,
              res,
              w,
              modelUid,
              _lspTN,
              _tam,
              _protocol,
              callOpts,
            )
          : _streamOaToCascade(
              retryRes,
              res,
              w,
              modelUid,
              _lspTN,
              _tam,
              _protocol,
              callOpts._localWorkspaceFallback,
              callOpts,
            ));

        // 检查重试响应中是否又有服务端工具调用
        _remainingServerCalls =
          (_lastRetryResult && _lastRetryResult.serverSideCalls) || [];
        if (
          _pendingLocalTranscriptMessages.length > 0 &&
          _remainingServerCalls.length === 0
        ) {
          _rememberLocalToolTranscript(
            callOpts._promptCacheKey,
            _pendingLocalTranscriptMessages,
            ((_lastRetryResult && _lastRetryResult.lspSideCalls) || []).map(
              (toolCall) => toolCall.id,
            ),
          );
          _routeDiag(
            `_localToolTranscript remember messages=${_pendingLocalTranscriptMessages.length} anchors=${((_lastRetryResult && _lastRetryResult.lspSideCalls) || []).length}`,
          );
          _pendingLocalTranscriptMessages = [];
        }
        if (_localGrepRetry && !_forceFinalSynthesis) {
          _currentMessages.push({
            role: "user",
            content:
              "Continue with the available native workspace tools. Fast Context/code_search is intentionally deferred until the next Devin-native tool turn; do not claim that it is unavailable or skipped.",
          });
        }
        if (_remainingServerCalls.length === 0) {
          _log(
            `[dao-router] ⚡ 内部重试 #${_retryCount} 完成: 无更多服务端工具调用`,
          );
          break;
        }

        // ★ v9.9.86 · 保留重试轮的 thinking + text 内容
        _prevTextAccum = (_lastRetryResult && _lastRetryResult.textAccum) || "";
        _prevThinkAccum =
          (_lastRetryResult && _lastRetryResult.thinkAccum) || "";
      }

      // ★ v9.9.86 · 流最终化: 检查流是否仍打开 → 手动关闭
      //   _streamOaToCascade 无服务端工具时自动关闭流 (streamFinalized=undefined)
      //   有服务端工具时流被保持打开 (streamFinalized=false) → 需手动关闭
      const _needFinalize =
        streamResult.streamFinalized === false && // 原始流被保持打开
        (!_lastRetryResult || _lastRetryResult.streamFinalized === false); // 重试也没关闭
      if (_needFinalize) {
        const _finalStopReason =
          (_lastRetryResult && _lastRetryResult.stopReason) || w.STOP_END;
        const _msgId = Date.now();
        const _hdrBuf = w.buildFrameHeader(_msgId, _msgId);
        if (_finalStopReason !== null) {
          const parts = [];
          parts.push(_hdrBuf);
          parts.push(w.encodeUint(w.RSP.STOP_REASON, _finalStopReason));
          const fr = w.buildFrame(0, Buffer.concat(parts));
          if (fr && fr.length) res.write(fr);
        }
        if (w.buildEndFrame) {
          const fr = w.buildEndFrame(null);
          if (fr && fr.length) res.write(fr);
        }
        if (!res.writableEnded) res.end();
        _log(`[dao-router] ⚡ 流最终化: stopReason=${_finalStopReason}`);
      }

      if (_retryCount >= _MAX_RETRIES && _remainingServerCalls.length > 0) {
        _log(
          `[dao-router] ⚡ 内部重试达到上限 ${_MAX_RETRIES}: ${_remainingServerCalls.length} 个未处理`,
        );
      }
    }

    // ★ v9.9.301 · 用量聚合 (按渠道/模型) · 供「外接API」面板查看
    try {
      _finishLatencyObservation(callOpts);
      if (callOpts._cacheObservation && streamResult) {
        callOpts._cacheObservation.stopReason = streamResult.stopReason;
        callOpts._cacheObservation.responseToolCount =
          streamResult.toolCount || 0;
        callOpts._cacheObservation.textBytes = streamResult.textBytes || 0;
      }
      _recordUsage(
        target.provider,
        sendModel,
        (streamResult && streamResult.tokenCount) || null,
        callOpts._cacheObservation || null,
      );
      if (
        _promptCachePolicy &&
        callOpts._cacheWarmupCandidate &&
        !_getUpstreamCircuit(target.provider, sendModel)
      ) {
        _promptCachePolicy.scheduleWarmup(callOpts._cacheWarmupCandidate);
      }
    } catch {}

    _log(
      `[dao-router] ${tag}[✓] ${modelUid} → ${target.provider}/${sendModel}`,
    );
    _routeDiag(
      `_tryRoute ${tag} SUCCESS: ${modelUid} → ${target.provider}/${sendModel}`,
    );
    _clearUpstreamCircuit(target.provider, sendModel);
    return true;
  } catch (e) {
    _log(`[dao-router] ${tag}[✗] ${target.provider} 异常: ${e.message}`);
    _routeDiag(
      `_tryRoute ${tag} EXCEPTION: ${e.message} provider=${target.provider} model=${sendModel}`,
    );
    if (isPrimary && e.message.includes("ECONNREFUSED")) {
      _healthCache[target.provider] = { alive: false, ts: Date.now() };
    }
    _openUpstreamCircuit(target.provider, sendModel, 0, e && e.message, null);
    if (callOpts) {
      callOpts._lastErr = {
        status: 502,
        provider: target.provider,
        body: String((e && e.message) || "upstream stream failure").slice(
          0,
          300,
        ),
      };
    }
    return false;
  }
}

/**
 * 状态快照 · 供 MITM /health 端点使用
 */
function status() {
  const provHealth = {};
  for (const [name, h] of Object.entries(_healthCache)) {
    provHealth[name] = { alive: h.alive, ageMs: Date.now() - h.ts };
  }
  const now = Date.now();
  const upstreamCircuits = Array.from(_upstreamCircuits.values())
    .filter((circuit) => circuit.until > now)
    .map((circuit) => ({
      provider: circuit.provider,
      model: circuit.model,
      status: circuit.status,
      reason: circuit.reason,
      remainingMs: circuit.until - now,
    }));
  return {
    ready: _ready,
    count: Object.keys(_routes).length,
    uids: Object.keys(_routes),
    gateway: _gatewayUrl,
    stats: { ..._stats },
    providers: Object.keys(_providers),
    provHealth,
    upstreamCircuits,
    conversationAffinities: _conversationProviderAffinity.size,
    routeRuntime: Object.fromEntries(_routeRuntime),
    contextStrategy: _contextStrategy
      ? _contextStrategy.status()
      : { sessions: 0, checkpoints: 0, last: null },
    promptCachePolicy: _promptCachePolicy
      ? _promptCachePolicy.status()
      : { unsupportedProviders: [], activeWarmups: 0 },
    toolStrategy: _toolStrategy
      ? _toolStrategy.status()
      : { sessions: 0, searches: 0, last: null },
    toolOutputStore: _toolOutputStore
      ? _toolOutputStore.status()
      : { enabled: false },
    workspaceToolStrategy: _workspaceToolStrategy
      ? _workspaceToolStrategy.status()
      : { sessions: 0, degradedSessions: 0, last: null },
  };
}

// ════════════════════════════════════════════════════════════════
// §2  私有辅助
// ════════════════════════════════════════════════════════════════

/**
 * ★ v9.9.85b · 修复 OpenAI 消息序列
 *   保留真实 tool 结果作为续跑请求末项，由模型据此生成下一条 assistant。
 */
// ★ v9.9.86 · _fixOAMessages (简化版) — 已合并到下方完整版
//   保留此占位以避免行号偏移

/**
 * 将 Cascade 消息格式 → OpenAI messages 数组
 */
function _buildOAMessages(parsed) {
  const messages = [];
  if (parsed.system) messages.push({ role: "system", content: parsed.system });
  for (const m of parsed.messages || []) {
    const isToolResult =
      m.role !== "assistant" && (m.role === "tool" || !!m.tool_call_id);
    const out = {
      role: isToolResult ? "tool" : m.role || "user",
    };
    const hasImages = Array.isArray(m.images) && m.images.length > 0;

    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length
    ) {
      // assistant + tool_calls
      out.content = hasImages
        ? [{ type: "text", text: m.content || "" }, ...m.images]
        : m.content || null;
      out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id || "",
        type: "function",
        function: {
          name: tc.name || "",
          arguments: tc.argumentsJson || "{}",
        },
      }));
      // ★ v9.9.80 · 思考内容: DeepSeek 多轮对话需回传 reasoning_content
      // ★ v9.9.84 · 严格模式: 有 tool_calls 的 assistant 必须带 reasoning_content
      //   DeepSeek API 文档: "for turns that do perform tool calls,
      //   the reasoning_content must be fully passed back to the API"
      //   若 LSP 未保存 thinking → 补空字符串 → 防止 400 错误
      //   道义: 无以为而有以为 · 无思考亦当有思考之位
      out.reasoning_content = m.thinking || "";
    } else if (m.role === "assistant") {
      // assistant (no tool_calls)
      out.content = hasImages
        ? [{ type: "text", text: m.content || "" }, ...m.images]
        : m.content || "";
      // ★ v9.9.80 · 思考内容
      // ★ v9.9.84 · 无 tool_calls 的 assistant: reasoning_content 可选 (传了也会被忽略)
      //   但为安全起见仍然回传 (利而不害)
      if (m.thinking) out.reasoning_content = m.thinking;
    } else if (isToolResult) {
      // tool result
      out.content =
        (m.tool_result_is_error ? "[ERROR] " : "") + (m.content || "");
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    } else {
      // user / system
      out.content = hasImages
        ? [{ type: "text", text: m.content || "" }, ...m.images]
        : m.content || "";
    }
    messages.push(out);
  }
  return messages;
}

/**
 * 修复 OpenAI 格式消息序列 · 确保每个 tool_calls 都有对应的 tool 响应
 * DeepSeek 严格要求: assistant tool_calls 后必须紧跟每个 tool_call_id 的 tool 响应
 */
function _fixOAMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const fixed = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    fixed.push(m);
    // 如果是 assistant 且有 tool_calls，检查后续是否有对应的 tool 响应
    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      const requiredIds = new Set(m.tool_calls.map((tc) => tc.id));
      // 扫描后续消息，收集已有的 tool_call_id
      const providedIds = new Set();
      for (
        let j = i + 1;
        j < messages.length && messages[j].role === "tool";
        j++
      ) {
        if (messages[j].tool_call_id) providedIds.add(messages[j].tool_call_id);
      }
      // 为缺失的 tool_call_id 添加占位响应
      for (const tc of m.tool_calls) {
        if (!providedIds.has(tc.id)) {
          fixed.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `[tool result for ${tc.function?.name || tc.id}]`,
          });
        }
      }
    }
  }
  return fixed;
}

/** 快速健康检查 (带缓存) */
function _checkHealth(name, healthUrl) {
  const cache = _healthCache[name];
  if (cache && Date.now() - cache.ts < HEALTH_TTL)
    return Promise.resolve(cache.alive);
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(healthUrl);
    } catch (e) {
      _log(
        `[dao-router] _checkHealth URL parse fail: ${healthUrl} · ${e.message}`,
      );
      return resolve(false);
    }
    const mod = u.protocol === "https:" ? https : http;
    // ★ 健康探测需带鉴权: 第三方模型站 /v1/models 多需 Bearer · 无 key 必 401 → 误判 DEAD(红点)
    //   道义: 三十九章「得一以宁」· 得 apiKey 之全方能验真
    const headers = { Accept: "application/json" };
    const provCfg = _providers[name];
    if (provCfg && provCfg.apiKey && !/\*{2,}/.test(provCfg.apiKey)) {
      headers["Authorization"] = "Bearer " + provCfg.apiKey;
      if (provCfg.type === "anthropic") {
        headers["x-api-key"] = provCfg.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      }
    }
    const req = mod.request(
      {
        hostname: u.hostname,
        port: parseInt(u.port || (u.protocol === "https:" ? "443" : "80")),
        path: u.pathname + (u.search || ""),
        method: "GET",
        headers,
        timeout: 5000,
        rejectUnauthorized: _tlsRejectUnauthorized(),
      },
      (res) => {
        res.resume();
        const alive = res.statusCode >= 200 && res.statusCode < 400;
        _healthCache[name] = { alive, ts: Date.now() };
        _log(
          `[dao-router] _checkHealth ${name}: ${alive ? "ALIVE" : "DEAD"} (${res.statusCode}) url=${healthUrl}`,
        );
        resolve(alive);
      },
    );
    req.on("error", (e) => {
      _healthCache[name] = { alive: false, ts: Date.now() };
      _log(
        `[dao-router] _checkHealth ${name} ERROR: ${e.message} url=${healthUrl}`,
      );
      resolve(false);
    });
    req.on("timeout", () => {
      req.destroy();
      _healthCache[name] = { alive: false, ts: Date.now() };
      _log(`[dao-router] _checkHealth ${name} TIMEOUT url=${healthUrl}`);
      resolve(false);
    });
    req.end();
  });
}

/**
 * 自动探活 provider baseUrl (支持 baseUrlFallbackPorts)
 */
function _resolveBaseUrl(provCfg) {
  const primary = provCfg.baseUrl;
  const fallbackPorts = provCfg.baseUrlFallbackPorts || [];
  if (!fallbackPorts.length) return Promise.resolve(primary);
  // ★ v9.9.64 · 修: new Promise(async) 反模式 → async IIFE
  return (async () => {
    for (const testUrl of [
      primary,
      ...fallbackPorts.map((p) => primary.replace(/:?\d+$/, ":" + p)),
    ]) {
      try {
        const u = new URL(testUrl);
        const alive = await _checkHealth(
          "_resolve_" + u.port,
          testUrl.replace(/\/v.*$/, "") + "/admin/health",
        );
        if (alive) {
          return testUrl.replace(/\/v.*$/, "");
        }
      } catch {}
    }
    return primary; // 全部失败默认用主端口
  })();
}

/**
 * 调用 provider 端点
 * noProviderPrefix=true  → model 原名直发（github/Azure）
 * modelPrefix=xxx        → xxx/model 发到 baseUrl（cascadeRelay/windsurfRelay 通过070网关）
 * 其他              → gatewayUrl + providerName::model
 */
async function _callProvider(
  provCfg,
  providerName,
  model,
  messages,
  tools,
  toolChoice,
  maxOutputTokens,
  target, // ★ v9.9.80 · 路由配置 (含 thinkingEnabled 等)
  lspToolNames, // ★ v9.9.83 · LSP 原始工具名集合 (修正 isCustomToolCall)
  callOpts, // ★ v9.9.92 · 修法⑦ · 回填 _toolAliasMap
) {
  // ★ v9.9.64 · 修: new Promise(async) 反模式 → async IIFE + new Promise
  //   反模式中 async throw 不触发 reject → unhandledRejection → Windsurf reload
  return (async () => {
    const _proxyManagedExecution = _usesProxyManagedExecution(target);
    if (callOpts) callOpts._proxyManagedExecution = _proxyManagedExecution;
    // ★ 出站脱敏: 每次 _callProvider 都过一遍 (本地 tool 重试会重入 · 覆盖后续 tool result)
    messages = _applyOutboundRedaction(messages, target, callOpts);
    const _protocolDecision = _resolveTargetProtocolDecision(
      target,
      provCfg,
      model,
    );
    let _resolvedProtocol = _protocolDecision.protocol;
    if (callOpts) callOpts._protocolDecision = _protocolDecision;
    if (_protocolDecision.adjusted) {
      _routeDiag(
        `route() protocol adjusted: configured=${_protocolDecision.configuredProtocol || "none"} actual=${_protocolDecision.protocol} reason=${_protocolDecision.reason}`,
      );
    }
    if (!_resolvedProtocol && callOpts && callOpts._detectedProtocol) {
      _resolvedProtocol = callOpts._detectedProtocol;
    }
    const _persistToolOutputs = _usesPersistedToolOutputs(
      target,
      provCfg,
      model,
      _resolvedProtocol,
    );
    let toolsField;
    const sourceTools =
      callOpts && callOpts._forceNoTools
        ? null
        : callOpts && Array.isArray(callOpts._allTools)
          ? callOpts._allTools
          : tools;
    if (Array.isArray(sourceTools) && sourceTools.length > 0) {
      toolsField = sourceTools
        .map((t) => {
          // ★ v9.9.79 · 兼容两种 tools 格式
          //   decodeChatToolDefinition 返回: {type:"function", function:{name,description,parameters}}
          //   其他来源可能返回: {name, description, inputSchema/parameters}
          //   道义: 三十九章「得一」· 两种格式得一即通
          const fn = t.function || t;
          return {
            type: "function",
            function: {
              name: fn.name || t.name || "",
              description: fn.description || t.description || "",
              parameters: fn.parameters || t.inputSchema || t.parameters || {},
            },
          };
        })
        .filter((t) => t.function.name && t.function.name.length > 0);

      // ★ v9.9.101 · 太上下知有之 · 工具层完全同步官方 · 不规范化和过滤
      //   道义: 不论是基础设施层还是提示词层完全和官方一致
      //   根因: normalizeToolDefs + _KNOWN_TOOL_NAMES白名单过滤 → 与官方API不一致
      //   修复: 直接透传原始工具名(与官方API一致) · 不normalize · 不filter · 不denormalize
      //   官方API收到LSP别名(Read/Edit/Grep) · DeepSeek也应收到LSP别名
      //   DeepSeek响应中也是LSP别名 · 无需反规范化 · Windsurf直接识别
      let _toolAliasMap = null; // ★ v9.9.101 · 置空 · 不规范化 · 透传原始名

      // ★ v9.9.101 · 太上下知有之 · 补充工具去重: 检查LSP别名映射
      //   不再规范化后，LSP发送别名(CodeSearch)，补充工具是标准名(code_search)
      //   需要检查别名映射避免重复添加 · 大制无割 · 同一工具不应出现两次
      //   道义: 四十章「天下之物生于有」· 有工具方能调用 · 无则不调
      const _existingNames = new Set(toolsField.map((t) => t.function.name));
      // ★ v9.9.101 · 构建反向映射: 标准名 → LSP别名
      //   如果LSP发了CodeSearch(alias) → code_search(standard) 已存在 → 不补充
      const _stdToAlias = {};
      if (_spInvert && _spInvert.TOOL_ALIAS_TO_STANDARD) {
        for (const [alias, std] of Object.entries(
          _spInvert.TOOL_ALIAS_TO_STANDARD,
        )) {
          _stdToAlias[std] = alias;
        }
      }
      for (const st of _serverToolDefs) {
        if (
          !_proxyManagedExecution &&
          !(st._persistedOutputOnly && _persistToolOutputs)
        ) {
          continue;
        }
        if (
          callOpts &&
          callOpts._suppressProxyTools &&
          _retrySuppressedToolNames.has(st.name)
        ) {
          continue;
        }
        if (st._customModelOnly && !(target && target._customModel)) continue;
        if (st._persistedOutputOnly && !_persistToolOutputs) continue;
        // 检查标准名和LSP别名是否都已存在
        const _aliasName = _stdToAlias[st.name];
        if (!_existingNames.has(st.name) && !_existingNames.has(_aliasName)) {
          const { _customModelOnly, _persistedOutputOnly, ...toolDefinition } =
            st;
          toolsField.push({ type: "function", function: toolDefinition });
          _existingNames.add(st.name);
        }
      }

      // ★ Windows Agent 原生工具注入 · windows-agent 经藏启用时与官方工具并列
      if (_proxyManagedExecution && _winTools && _winTools.enabled()) {
        for (const wt of _winTools.defs()) {
          if (!_existingNames.has(wt.name)) {
            toolsField.push({ type: "function", function: wt });
            _existingNames.add(wt.name);
          }
        }
      }

      // ★ v9.9.101 · 太上下知有之 · 移除工具白名单过滤
      //   道义: 官方API不过滤工具 · DeepSeek也不应过滤 · 所有工具透传
      //   旧逻辑: _KNOWN_TOOL_NAMES 白名单 + MCP前缀 → 其他丢弃
      //   根因: 白名单过滤导致新工具/MCP工具丢失 → 与官方不一致
      //   修复: 不过滤 · 透传所有工具 · 与官方API完全一致
      //   _KNOWN_TOOL_NAMES 保留用于诊断日志(不用于过滤)

      // ★ v9.9.301 · 记忆模块工具整条剔除(防御性) · 与 source.js dropMemoryToolsProto 同源意图
      //   道义: 道恒无名 · 记忆体系本属官方着相 · 模型根本不应知有"记忆"
      //   主剔除在 source.js 最上游(两路同净);此处为外接路径防御补刀
      //   (source.js 旧版/被绕过时仍保第三方渠道无记忆工具暴露)。
      if (_proxyManagedExecution) {
        const _memBefore = toolsField.length;
        toolsField = toolsField.filter(
          (t) =>
            !/memor(?:y|ies)/i.test((t && t.function && t.function.name) || ""),
        );
        if (toolsField.length !== _memBefore)
          _routeDiag(
            "memory tools dropped: " + (_memBefore - toolsField.length),
          );
      }

      if (_proxyManagedExecution && _contextStrategy) {
        toolsField = _contextStrategy.decorateTools(toolsField);
      }

      // ★ v9.9.287 · 道恒无名 · 工具描述去官名 · 反者道之动
      //   根因: 官方工具描述内嵌产品标识 (browser_preview/edit_notebook 述及
      //   "Cascade" · check_deploy_status 述及 "Windsurf") · 随 tools 字段透传至
      //   真实渠道 → 模型读描述见"Cascade"被当作执行体 → 自认为 "Cascade"。
      //   纯 deepseek 不识此名 · 故必是官方内容流入最上游 (非据工具反推)。
      //   道义: 三十二章「道恒无名」· 一章「名可名也非恒名也」· 名去则惑除。
      //   修复: 发往渠道前中性化描述中的官方产品名 → "you"/"the editor"
      //   (与道化 SP「你本無名」一致 · 以"你"称之) · 不改工具名/参数 · 机制不破。
      //   v9.9.288 · 去名扩展至参数描述: 顶层 description + parameters 内任意层级
      //   description 字段一并中性化 (run_command 等工具的参数描述实测仍含 "Cascade")。
      if (_proxyManagedExecution) {
        for (const _tf of toolsField) {
          if (_tf && _tf.function) {
            _tf.function.description = _deOfficialName(
              _tf.function.description,
            );
            if (_tf.function.parameters)
              _deOfficialDescDeep(_tf.function.parameters);
            if (
              /^(?:CodeSearch|code_search|SmartReading|smart_reading)$/i.test(
                _tf.function.name || "",
              )
            ) {
              const guard =
                "Workspace boundary: use this tool only for paths inside the IDE-registered workspace. For absolute paths outside that workspace, use Read, Grep, FindByName, or ListDir instead.";
              if (!String(_tf.function.description || "").includes(guard)) {
                _tf.function.description =
                  `${_tf.function.description || ""}\n\n${guard}`.trim();
              }
            }
          }
        }
      }

      if (_proxyManagedExecution && _workspaceToolStrategy) {
        toolsField = _workspaceToolStrategy.filterTools({
          key: callOpts && callOpts._promptCacheKey,
          tools: toolsField,
        });
      }

      if (
        _toolStrategy &&
        _proxyManagedExecution &&
        provCfg.streamMode !== "unary" &&
        target.contextStrategy &&
        target.contextStrategy.deferMcpTools === true
      ) {
        const selection = _toolStrategy.select({
          key: callOpts && callOpts._promptCacheKey,
          tools: toolsField,
          messages,
          maxContextTokens: (callOpts && callOpts._contextMaxTokens) || 131072,
        });
        toolsField = selection.tools;
        if (callOpts) callOpts._toolStrategyStats = selection.stats;
        if (selection.stats.enabled) {
          _routeDiag(
            `_callProvider tool-strategy: sent=${selection.stats.sentTools}/${selection.stats.originalTools} deferred=${selection.stats.deferredTools} tokens=${selection.stats.deferredTokens}/${selection.stats.thresholdTokens}`,
          );
        }
      }

      if (toolsField.length === 0) toolsField = undefined;
      // ★ v9.9.80 · 诊断: 记录实际传给 provider 的工具名
      _routeDiag(
        "_callProvider tools: count=" +
          (toolsField ? toolsField.length : 0) +
          " names=" +
          (toolsField
            ? toolsField.map((t) => t.function.name).join(",")
            : "(none)"),
      );
    }

    // ★ v9.9.101 · 太上下知有之 · DeepSeek路由增强SP
    //   道义: 十七章「太上 下知有之」· DAO存在但不可见 · 官方功能完整保留
    //   根因: source.js invertSP()完全替换官方SP → DeepSeek无官方指令 → 工具不可用
    //   修复: 在 _callProvider 中增强SP — 保留官方SP + 追加DAO文本 · 非替换
    //   此处是热重载安全区 · dao_router.js 的修改会被 _eaHotReload 自动生效
    if (
      _proxyManagedExecution &&
      Array.isArray(messages) &&
      messages.length > 0 &&
      messages[0].role === "system" &&
      typeof messages[0].content === "string"
    ) {
      const _spText = messages[0].content;
      const _isInverted = _spInvert && _spInvert.isAlreadyInverted(_spText);
      const _isEnhanced = _spText.indexOf("<!-- DAO-ENHANCE") >= 0;
      const _isOfficial = _spInvert && _spInvert.isLikelyOfficialSP(_spText);
      if (!_isInverted && !_isEnhanced && _isOfficial) {
        // ★ 官方SP未被道化/增强 → 增强模式: 保留官方SP + 追加DAO
        const _daoText = _getDaoEnhanceText();
        if (_daoText) {
          const _enhanced = _spText + _ENHANCE_MARKER + _daoText;
          _routeDiag(
            `[太上·增强SP] ${_spText.length}B → ${_enhanced.length}B (官方SP保留 + DAO增强)`,
          );
          messages[0].content = _enhanced;
        }
      } else if (_isEnhanced) {
        _routeDiag(
          `[dao-router] [SP已增强] ✓ 太上模式 ${_spText.length}B · 官方SP保留 + DAO增强 · 工具指令完整`,
        );
      }
      // ★ v9.9.288 · 道恒无名 · SP 去官名 (发渠前最后一步)
      //   根因: 官方SP尾部默认工作目录 "CascadeProjects" 等产品名随增强SP透传给真实渠道
      //   → 模型读 SP 见 "Cascade" 强化自认身份 (与工具描述同源·此前仅去了工具未去SP)。
      //   修复: 对最终 SP 内容做去名归一 (CascadeProjects→Projects · Cascade→you 等)。
      if (typeof messages[0].content === "string") {
        const _spBefore = messages[0].content;
        const _spAfter = _deOfficialName(_spBefore);
        if (_spAfter !== _spBefore) {
          messages[0].content = _spAfter;
          _routeDiag(
            `[道恒无名·SP去名] ${_spBefore.length}B → ${_spAfter.length}B (中性化官方产品名)`,
          );
        }
      }
    }

    // ★ v9.9.88 · compact system message (移植自 EXE compactPromptText)
    //   压缩 SP 多余空白 · 节省 token · 道义: 损之又损
    if (
      _proxyManagedExecution &&
      Array.isArray(messages) &&
      messages.length > 0 &&
      messages[0].role === "system" &&
      typeof messages[0].content === "string"
    ) {
      const _origLen = messages[0].content.length;
      messages[0].content = _compactPromptText(messages[0].content);
      if (messages[0].content.length < _origLen) {
        _routeDiag(
          "_callProvider compact SP: " +
            _origLen +
            " → " +
            messages[0].content.length +
            " (-" +
            (_origLen - messages[0].content.length) +
            ")",
        );
      }
    }

    // ★ v9.9.307 · 本源观照·真上游 · 回传第三方实发之全文(system+messages+tools)给面板
    //   道义: 十四章「执今之道·以御今之有」· 观其真实所往 · 不滞 devin 侧经文
    //   仅观察 · 不改 body · 失败静默 · 不扰路由
    try {
      if (typeof global.__DAO_RECORD_UPSTREAM === "function") {
        global.__DAO_RECORD_UPSTREAM({
          provider: providerName,
          model: model,
          messages: messages,
          tools: toolsField,
        });
      }
    } catch {}

    let _adapter = null;
    let _protocol = _resolvedProtocol;
    if (_adapters) {
      _protocol = _protocol || _adapters.detectProtocol(provCfg, model);
      _adapter = _adapters.adapterFor(_protocol);
    }
    const _reasoning = _requestReasoningSettings(
      target,
      _protocol || "openai-chat",
      model,
      !!(toolsField && toolsField.length),
    );
    if (callOpts && callOpts._disableReasoningParams) {
      _reasoning.thinkingEnabled = false;
      _reasoning.thinkingBudget = null;
      _reasoning.reasoningEffort = null;
      _reasoning.adjusted = false;
    }
    if (_reasoning.adjusted) {
      _routeDiag(
        `_callProvider reasoning adjusted: protocol=openai-chat model=${model} tools=1 effort=none`,
      );
    }

    let bodyObj = { messages, stream: provCfg.streamMode !== "unary" };
    // ★ 提示缓存观测: 流式时请求末尾 usage 块 (OpenAI/DeepSeek 兼容)
    //   不发则流式响应无 usage → cached 永为 0 → 命中率假零。provCfg.streamUsage=false 可关
    if (bodyObj.stream && provCfg.streamUsage !== false) {
      bodyObj.stream_options = { include_usage: true };
    }
    if (toolsField) {
      bodyObj.tools = toolsField;
      if (callOpts && callOpts._disableParallelToolCalls) {
        bodyObj.parallel_tool_calls = false;
      }
      // ★ v9.9.84 · DeepSeek V4 thinking 模式不支持 tool_choice
      //   实证: https://github.com/deepseek-ai/DeepSeek-V3/issues/1376
      //   thinking 模式下发送 tool_choice → 400 或被忽略 → 不可预测行为
      //   非 thinking 模式: 正常发送 tool_choice
      //   道义: 知止不殆 · 知其不可为则不为
      const _isThinkingMode = _reasoning.thinkingEnabled;
      if (!_isThinkingMode) {
        bodyObj.tool_choice = toolChoice || "auto";
      }
    }
    if (maxOutputTokens) bodyObj.max_tokens = maxOutputTokens;

    // ★ v9.9.309 · 采样温度 · 路由可配 · 留空则不发(用模型默认) · 参照通用 OpenAI 兼容配置
    if (
      target &&
      typeof target.temperature === "number" &&
      !Number.isNaN(target.temperature)
    ) {
      bodyObj.temperature = target.temperature;
    }

    // ★ v9.9.80 · 思考模式: DeepSeek V3.2 支持 thinking + tools
    //   配置中 thinkingEnabled=true → 请求体加 thinking:{type:"enabled"}
    //   响应 SSE 中 delta.reasoning_content 包含思考内容
    //   _streamOaToCascade 已支持 reasoning_content → DELTA_THINKING 帧
    //   道义: 三十九章「神得一以灵」· 得思考方能灵
    if (_reasoning.thinkingEnabled) {
      bodyObj.thinking = { type: "enabled" };
      if (_reasoning.thinkingBudget)
        bodyObj.thinking.budget_tokens = _reasoning.thinkingBudget;
      _routeDiag("_callProvider thinking: enabled for model=" + model);
    }
    if (_reasoning.reasoningEffort)
      bodyObj.reasoning_effort = _reasoning.reasoningEffort;

    // ★ v9.9.99 · 多协议适配 (移植自 Go adapters)
    //   道义: 二十八章「知其白 守其辱 为天下式」
    //   知各协议之白 · 守其转换之辱 · 为天下适配之式
    //   Anthropic → /v1/messages · Responses → /v1/responses · 其他 → /v1/chat/completions
    const _promptCacheKey = _resolvePromptCacheKey(
      provCfg,
      target,
      providerName,
      model,
      callOpts,
    );
    callOpts._cacheObservation = {
      source: "cascade",
      protocol: _protocol || null,
      sessionHash:
        callOpts && callOpts._promptCacheKey
          ? _cacheFingerprint(callOpts._promptCacheKey)
          : null,
      agentSessionHash:
        callOpts && callOpts._agentStatusKey
          ? _cacheFingerprint(callOpts._agentStatusKey)
          : null,
      cacheKeyHash: _promptCacheKey ? _cacheFingerprint(_promptCacheKey) : null,
      systemHash: _cacheFingerprint(
        messages.length > 0 && messages[0].role === "system"
          ? messages[0].content || ""
          : "",
      ),
      toolsHash: _cacheFingerprint(toolsField || []),
      messagesHash: _cacheFingerprint(messages),
      messageCount: messages.length,
      toolCount: toolsField ? toolsField.length : 0,
    };

    if (_adapter && _protocol !== "openai-chat") {
      // ── 非默认协议: 使用适配器构建请求 ──
      let adapterBody = _adapter.buildRequest({
        messages,
        tools: toolsField,
        toolChoice,
        maxOutputTokens,
        model,
        stream: provCfg.streamMode !== "unary",
        thinkingEnabled: _reasoning.thinkingEnabled,
        thinkingBudget: _reasoning.thinkingBudget,
        reasoningEffort: _reasoning.reasoningEffort,
        promptCacheKey:
          _protocol === "openai-responses" ? _promptCacheKey : null,
        continuationKey:
          _protocol === "openai-responses"
            ? _responsesContinuationKey(
                providerName,
                model,
                callOpts && callOpts._promptCacheKey,
              )
            : null,
        responsesStore:
          _protocol === "openai-responses" &&
          !!(target && target.responsesStore === true),
        includeEncryptedReasoning:
          _protocol === "openai-responses" &&
          !(callOpts && callOpts._disableEncryptedReasoning),
        system:
          messages.length > 0 && messages[0].role === "system"
            ? messages[0].content
            : "",
      });
      if (callOpts && _protocol === "openai-responses") {
        callOpts._responsesContinuationKey = _responsesContinuationKey(
          providerName,
          model,
          callOpts._promptCacheKey,
        );
      }
      delete adapterBody.__dao_stream;
      adapterBody = _decoratePromptCacheBody(
        adapterBody,
        provCfg,
        target,
        providerName,
        model,
        _protocol,
        _promptCacheKey,
        callOpts,
      );

      let targetUrl,
        extraHeaders = {};

      // URL 构建
      const completionPath = _adapter.getCompletionPath(
        provCfg,
        model,
        provCfg.streamMode !== "unary",
      );
      if (provCfg.baseUrl) {
        const resolvedBase = await _resolveBaseUrl(provCfg);
        targetUrl = new URL(_joinCompletionUrl(resolvedBase, completionPath));
      } else {
        targetUrl = new URL(_gatewayUrl + completionPath);
      }

      // 适配器专用头
      const adapterOpts = _adapter.buildRequestOpts(
        provCfg,
        adapterBody,
        targetUrl,
      );
      extraHeaders = { ...extraHeaders, ...(adapterOpts.headers || {}) };

      const body = JSON.stringify(adapterBody);
      const isHttps = targetUrl.protocol === "https:";
      const mod = isHttps ? https : http;

      _routeDiag(
        `_callProvider adapter: protocol=${_protocol} url=${targetUrl.href} bodyLen=${body.length}`,
      );
      _routeDiag(
        `_callProvider request-contract provider=${providerName} model=${model} protocol=${_protocol} reasoningEffort=${
          (adapterBody.reasoning && adapterBody.reasoning.effort) ||
          adapterBody.reasoning_effort ||
          "none"
        } thinkingBudget=${
          (adapterBody.thinking && adapterBody.thinking.budget_tokens) || "none"
        }`,
      );

      // ★ v9.9.102 · 修法㉑ · 注入代理agent
      const _upstreamAgent = _getAffinityAgent(
        isHttps,
        targetUrl,
        providerName,
        _promptCacheKey,
      );
      _routeDiag(
        `_callProvider cache affinity=${_promptCacheKey ? _cacheFingerprint(_promptCacheKey) : "shared"} keepAlive=1 provider=${providerName}`,
      );
      return new Promise((resolve, reject) => {
        const opts = {
          hostname: targetUrl.hostname,
          port: parseInt(targetUrl.port || (isHttps ? "443" : "80")),
          path: targetUrl.pathname + (targetUrl.search || ""),
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            // ★ v10.0 · 修法⑳ · Accept 根据流/非流动态设置
            Accept:
              provCfg.streamMode !== "unary"
                ? "text/event-stream"
                : "application/json",
            ...extraHeaders,
          },
          rejectUnauthorized: _tlsRejectUnauthorized(),
          agent: _upstreamAgent,
        };
        const req = mod.request(opts, (response) => {
          _routeDiag(
            `_callProvider socket reused=${req.reusedSocket ? 1 : 0} provider=${providerName} affinity=${_promptCacheKey ? _cacheFingerprint(_promptCacheKey) : "shared"}`,
          );
          resolve(response);
        });
        req.on("error", reject);
        // v9.9.339 · 反者道之动 · 撤销 provider 流式请求秒数硬限 · AI 自然而止
        //   本源: 推理/思考阶段可静默数分钟无字节, 120s socket 超时 destroy → 对话中途截断
        //   道并行防泄漏: 关默认超时(0) + TCP keepalive 探活, socket 真死方 error 冒泡自然收
        req.setTimeout(0);
        req.on("socket", (s) => {
          try {
            s.setKeepAlive(true, 45000);
          } catch {}
        });
        req.write(body);
        req.end();
      });
    }

    // ── 默认协议: OpenAI Chat (原有逻辑) ──

    if (_promptCacheKey) {
      bodyObj.prompt_cache_key = _promptCacheKey;
      _routeDiag(
        `_callProvider prompt_cache_key enabled provider=${providerName} model=${model}`,
      );
    }

    let targetUrl,
      extraHeaders = {};

    if (provCfg.baseUrl && provCfg.modelPrefix) {
      // ── 070网关前缀模式: cascadeRelay/gpt-5-4-low → 070网关 ──
      bodyObj.model = `${provCfg.modelPrefix}/${model}`;
      const completionPath = provCfg.completionPath || "/v1/chat/completions";
      const resolvedBase = await _resolveBaseUrl(provCfg);
      targetUrl = new URL(_joinCompletionUrl(resolvedBase, completionPath));
      if (provCfg.apiKey)
        extraHeaders["Authorization"] = `Bearer ${provCfg.apiKey}`;
    } else if (provCfg.baseUrl) {
      // ── 直连模式: 有 baseUrl 即直连真实渠道 (model原名直发) ──
      //   道义: 名实相符 · 配了 baseUrl 就发到 baseUrl · 不再丢给本地兜底网关
      //   修复: 缺 noProviderPrefix 的真实渠道(如 deepseek/github)曾被错丢到
      //   _gatewayUrl(127.0.0.1:11435) · 网关未起则 ECONNREFUSED → 回弹
      bodyObj.model = model;
      const completionPath = provCfg.completionPath || "/v1/chat/completions";
      const resolvedBase = await _resolveBaseUrl(provCfg);
      targetUrl = new URL(_joinCompletionUrl(resolvedBase, completionPath));
      if (provCfg.apiKey)
        extraHeaders["Authorization"] = `Bearer ${provCfg.apiKey}`;
    } else {
      // ── 兜底网关模式: 无 baseUrl → providerName::model → _gatewayUrl ──
      bodyObj.model = `${providerName}::${model}`;
      targetUrl = new URL(_gatewayUrl + "/v1/chat/completions");
    }

    bodyObj = _decoratePromptCacheBody(
      bodyObj,
      provCfg,
      target,
      providerName,
      model,
      "openai-chat",
      _promptCacheKey,
      callOpts,
    );
    const body = JSON.stringify(bodyObj);

    // ★ v9.9.82 · 诊断转储: 写出发给上游模型的完整请求体 (默认关 · 仅排障开)
    //   道义: 十六章「致虚极也 守情表也」· 致虚于日志 · 守情于实证
    //   反者道之动 · 不知实则不可修 · 知实则修之无碍
    if (_debugDumpEnabled()) try {
      const dumpPath = path.join(__dirname, "_upstream_req_dump.json");
      const systemMessage =
        bodyObj.messages &&
        bodyObj.messages[0] &&
        bodyObj.messages[0].role === "system"
          ? bodyObj.messages[0]
          : null;
      const systemText = !systemMessage
        ? ""
        : typeof systemMessage.content === "string"
          ? systemMessage.content
          : Array.isArray(systemMessage.content)
            ? systemMessage.content
                .map((block) =>
                  block && typeof block.text === "string" ? block.text : "",
                )
                .join("\n")
            : "";
      const dumpObj = {
        _ts: new Date().toISOString(),
        _model: model,
        _url: (targetUrl || {}).href || "?",
        // ★ v9.9.92-fix · 诊断 Authorization 是否存在 · 401 根因排查
        _extraHeaders: Object.keys(extraHeaders).reduce((acc, k) => {
          if (k.toLowerCase() === "authorization") {
            const v = extraHeaders[k] || "";
            acc[k] =
              v.length > 20
                ? v.substring(0, 10) + "...(" + v.length + "B)"
                : "(" + v.length + "B)";
          } else {
            acc[k] = extraHeaders[k];
          }
          return acc;
        }, {}),
        _toolsCount: toolsField ? toolsField.length : 0,
        _toolNames: toolsField ? toolsField.map((t) => t.function.name) : [],
        _sysLen: systemText.length,
        _sysPreview: systemMessage
          ? systemText.substring(0, 500)
          : "(no system msg)",
        // ★ v9.9.83 · 完整 SP (关键: 确认 tool_calling 区块是否存在)
        _sysFull: systemText,
        _msgCount: bodyObj.messages ? bodyObj.messages.length : 0,
        _promptCacheKey: bodyObj.prompt_cache_key || null,
        _sysHash: _cacheFingerprint(systemText),
        _toolsHash: _cacheFingerprint(toolsField || []),
        _thinking: !!bodyObj.thinking,
        // ★ v9.9.84 · messages 摘要: 排查 reasoning_content 缺失导致 400
        //   道义: 十六章「万物旁作 吾以观其复也」· 观其所缺方知所修
        _msgSummary: (bodyObj.messages || []).map((m, i) => {
          const c = typeof m.content === "string" ? m.content : "";
          // ★ v9.9.287 · 全消息预览 · 验证官方身份(Cascade/Windsurf)是否仍漏入任一消息
          const preview =
            c.length > 600 ? c.slice(0, 400) + " …<cut>… " + c.slice(-200) : c;
          return {
            idx: i,
            role: m.role,
            hasReasoningContent: "reasoning_content" in m,
            reasoningContentLen: (m.reasoning_content || "").length,
            hasToolCalls: !!(m.tool_calls && m.tool_calls.length),
            toolCallCount: m.tool_calls ? m.tool_calls.length : 0,
            toolCallId: m.tool_call_id || null,
            contentLen: typeof m.content === "string" ? m.content.length : -1,
            preview,
          };
        }),
        // ★ 完整 tools 定义 (关键!)
        _tools: toolsField || [],
      };
      fs.writeFile(dumpPath, JSON.stringify(dumpObj, null, 2), () => {});
    } catch (_de) {
      /* 诊断不阻塞 */
    }

    const isHttps = targetUrl.protocol === "https:";
    const mod = isHttps ? https : http;

    // ★ v9.9.102 · 修法㉑ · 注入代理agent (默认OpenAI协议路径)
    const _upstreamAgent2 = _getAffinityAgent(
      isHttps,
      targetUrl,
      providerName,
      _promptCacheKey,
    );
    _routeDiag(
      `_callProvider cache affinity=${_promptCacheKey ? _cacheFingerprint(_promptCacheKey) : "shared"} keepAlive=1 provider=${providerName}`,
    );
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: targetUrl.hostname,
        port: parseInt(targetUrl.port || (isHttps ? "443" : "80")),
        path: targetUrl.pathname + (targetUrl.search || ""),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          // ★ v10.0 · 修法⑳补 · Accept 根据流/非流动态设置
          Accept: bodyObj.stream ? "text/event-stream" : "application/json",
          ...extraHeaders,
        },
        rejectUnauthorized: _tlsRejectUnauthorized(),
        agent: _upstreamAgent2,
      };
      const req = mod.request(opts, (response) => {
        _routeDiag(
          `_callProvider socket reused=${req.reusedSocket ? 1 : 0} provider=${providerName} affinity=${_promptCacheKey ? _cacheFingerprint(_promptCacheKey) : "shared"}`,
        );
        resolve(response);
      });
      req.on("error", reject);
      // v9.9.339 · 反者道之动 · 撤销 provider 流式请求秒数硬限 · AI 自然而止
      //   本源: 推理/思考阶段可静默数分钟无字节, 120s socket 超时 destroy → 对话中途截断
      //   道并行防泄漏: 关默认超时(0) + TCP keepalive 探活, socket 真死方 error 冒泡自然收
      req.setTimeout(0);
      req.on("socket", (s) => {
        try {
          s.setKeepAlive(true, 45000);
        } catch {}
      });
      req.write(body);
      req.end();
    });
  })();
}

/**
 * ★ v9.9.86 · 执行服务端工具 (大制无割版)
 *   当 DeepSeek 调用 trajectory_search 等服务端工具时，代理层执行
 *   道义: 十七章「功述身芮」· 功成而身退 · LSP 不知有之
 *
 *   ★ v9.9.93 · 修法⑧ · 仅处理 _proxyOnlyToolNames 中的工具
 *   trajectory_search/code_search/ask_user_question 等不再被拦截
 *   这些工具直接透传给 LSP → LSP 自己执行 → 与 Go EXE 一致
 *   此函数仅处理 deploy_web_app / read_deployment_config / check_deploy_status / skill
 *   道义: 十七章「太上不知有之」· LSP 不知有代理 · 工具调用自然流转
 */
function _executeServerTool(name, argsJson, callOpts) {
  let args = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {}

  switch (name) {
    case "dao_tool_search": {
      if (!_toolStrategy) {
        return JSON.stringify({
          ok: false,
          error: "tool strategy unavailable",
        });
      }
      return JSON.stringify(
        _toolStrategy.search({
          key: callOpts && callOpts._promptCacheKey,
          query: args.query,
          limit: args.limit,
        }),
      );
    }
    case "dao_read_tool_output": {
      if (!_toolOutputStore) {
        return JSON.stringify({
          ok: false,
          error: "tool output store unavailable",
        });
      }
      return JSON.stringify(
        _toolOutputStore.read(args.output_id, args.offset, args.max_chars),
      );
    }
    case "code_search":
    case "CodeSearch":
    case "SmartReading":
    case "smart_reading":
    case "grep_search":
    case "Grep":
    case "GrepSearch":
    case "find_by_name":
    case "FindByName": {
      return _executeCachedReadOnlyTool(name, argsJson, callOpts);
    }
    // Other editor-owned tools remain on the native LSP path.
    case "trajectory_search":
    case "ask_user_question":
    case "create_memory":
    case "search_web":
    case "read_url_content":
    case "view_content_chunk":
    case "read_resource":
    case "edit_notebook":
    case "read_notebook": {
      // ★ v9.9.93 · 兜底: 这些工具不应再被拦截 → 但以防万一仍处理
      _log(
        `[dao-router] ⚠️ _executeServerTool ${name}: 不应到达此处 (LSP有执行器) → 返回不可用`,
      );
      return JSON.stringify({
        error: `${name} should be handled by LSP, not proxy. This indicates a bug in tool classification.`,
        status: "error",
      });
    }
    case "dao_report_test_result": {
      // 模型自报测试结果 → 写 agent_status.testReport。零解析、零推断。
      // agent_status.recordTestReport 会校验两个计数都是非负整数，
      // 不合法则返回 null —— 这里必须把「没记上」如实告诉模型（ok:false），
      // 否则它以为报成功了、后续轮次却读不到，比不报更糟。
      const state = _recordAgentTestReport(callOpts, {
        passed: args.passed,
        failed: args.failed,
        framework: args.framework,
      });
      if (!state || !state.testReport) {
        return JSON.stringify({
          ok: false,
          error:
            "test report rejected: passed and failed must both be non-negative integers, and an active session status is required",
        });
      }
      const tr = state.testReport;
      _routeDiag(
        `dao_report_test_result recorded status=${tr.status} passed=${tr.passed} failed=${tr.failed} framework=${tr.framework}`,
      );
      return JSON.stringify({
        ok: true,
        recorded: {
          status: tr.status,
          passed: tr.passed,
          failed: tr.failed,
          framework: tr.framework,
        },
        note: "Written to your status bar as a self-declared report. It will be read back in later turns until you replace it.",
      });
    }
    case "deploy_web_app":
    case "read_deployment_config":
    case "check_deploy_status": {
      _log(
        `[dao-router] _executeServerTool ${name}: not available in proxy mode`,
      );
      return JSON.stringify({
        error: `${name} is not available in proxy mode`,
        status: "unavailable",
      });
    }
    case "skill": {
      _log(
        `[dao-router] _executeServerTool skill: not available in proxy mode`,
      );
      return JSON.stringify({
        error: "skill is not available in proxy mode",
        status: "unavailable",
      });
    }
    default: {
      _log(`[dao-router] _executeServerTool unknown: ${name}`);
      return JSON.stringify({
        error: `Unknown server tool: ${name}`,
        status: "error",
      });
    }
  }
}

/** 读取全部响应体 (用于错误日志) */
function _readAll(agRes) {
  return new Promise((resolve) => {
    let d = "";
    agRes.on("data", (c) => (d += c));
    agRes.on("end", () => resolve(d));
    agRes.on("error", () => resolve(d));
  });
}

/**
 * 非流式 (unary) 响应转 Connect-RPC Cascade 帧
 * DeepSeek streamMode=unary 时返回普通 JSON
 */
async function _unaryOaToCascade(
  agRes,
  res,
  w,
  modelUid,
  lspToolNames,
  toolAliasMap,
  protocol,
  workspaceContext,
) {
  const body = await _readAll(agRes);
  let obj;
  try {
    obj = JSON.parse(body);
  } catch (e) {
    _log("[dao-router] _unaryOaToCascade: JSON parse fail: " + e.message);
    return;
  }

  // ★ v9.9.99 · 协议感知 unary 解析
  //   Anthropic: { type: "message", content: [...], stop_reason, usage }
  //   OpenAI Chat: { choices: [{ message }], usage }
  let msg, finishReason, usageInfo, toolCalls;
  let continuationItems = [];
  const proxyManagedExecution = !!(
    workspaceContext && workspaceContext._proxyManagedExecution
  );

  if (protocol !== "openai-chat" && _adapters) {
    const adapter = _adapters.adapterFor(protocol);
    const parsed = adapter.parseUnaryResponse(body);
    if (!parsed) return;
    msg = {
      content: parsed.content || "",
      reasoning_content: parsed.thinking || "",
    };
    finishReason = parsed.finishReason || "stop";
    usageInfo = parsed.usage || null;
    toolCalls = parsed.toolCalls || [];
    continuationItems = parsed.continuationItems || [];
  } else {
    // OpenAI Chat (原有逻辑)
    const choice = obj.choices && obj.choices[0];
    if (!choice) return;
    msg = choice.message || {};
    finishReason = choice.finish_reason || "stop";
    usageInfo = obj.usage || null;
    toolCalls = msg.tool_calls || [];
  }

  // ★ v9.9.72 · 生成 output_id / request_id · Windsurf LSP 需要这些字段关联请求
  const _outputId = `dao_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const _requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // actual_model_uid: 告诉 LSP 响应来自哪个模型 (field 23)
  const _actualModelUid = modelUid || "deepseek-chat";

  // ★ v9.9.78 · message_id + timestamp · 官方后端每帧必含
  //   实证: 官方后端每帧 payload 均含 field 1 (message_id) + field 2 (timestamp)
  //   无 message_id → LSP 无法关联帧 → "Encountered unexpected error"
  //   道义: 三十九章「得一」· 得 message_id + timestamp 方能宁
  const _messageId =
    "bot-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10);
  const _tsMs = Date.now();
  const _hdr = () => w.buildFrameHeader(_messageId, _tsMs);

  // ── 帧 1: message_id + timestamp + 文本 + actual_model_uid + output_id + request_id ──
  //   ★ v9.9.78 · 每帧含 message_id + timestamp · 与官方后端一致
  //   道义: 三十九章「得一」· LSP 得此二字段方能归位
  if (typeof msg.content === "string" && msg.content.length > 0) {
    const parts = [];
    parts.push(_hdr()); // ★ message_id + timestamp
    parts.push(w.encodeString(w.RSP.DELTA_TEXT, msg.content));
    parts.push(w.encodeString(w.RSP.ACTUAL_MODEL_UID, _actualModelUid));
    parts.push(w.encodeString(w.RSP.OUTPUT_ID, _outputId));
    parts.push(w.encodeString(w.RSP.REQUEST_ID, _requestId));
    const fr = w.buildFrame(0, Buffer.concat(parts));
    if (fr && fr.length) {
      res.write(fr);
      if (/\S/.test(msg.content)) _markFirstVisible(workspaceContext, "text");
    }
  } else {
    // 即使无文本内容, 也发 message_id + timestamp + actual_model_uid 帧
    const parts = [];
    parts.push(_hdr()); // ★ message_id + timestamp
    parts.push(w.encodeString(w.RSP.ACTUAL_MODEL_UID, _actualModelUid));
    parts.push(w.encodeString(w.RSP.OUTPUT_ID, _outputId));
    parts.push(w.encodeString(w.RSP.REQUEST_ID, _requestId));
    const fr = w.buildFrame(0, Buffer.concat(parts));
    if (fr && fr.length) res.write(fr);
  }

  // 思考内容 (DeepSeek R1) · 含 message_id + timestamp
  const think = msg.reasoning_content || msg.thinking || "";
  if (think && _EXPOSE_REASONING) {
    const parts = [];
    parts.push(_hdr()); // ★ message_id + timestamp
    parts.push(w.encodeString(w.RSP.DELTA_THINKING, think));
    const fr = w.buildFrame(0, Buffer.concat(parts));
    if (fr && fr.length) res.write(fr);
  }

  // ★ v9.9.99 · tool_calls · 统一使用 toolCalls 变量 (OpenAI/Anthropic/Responses)
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const mappedCalls = toolCalls.map((tc, i) => {
      const _rawName = tc.function?.name || tc.name || "";
      // ★ v9.9.101 · 太上下知有之 · 不反规范化 · 工具名直接透传
      //   不normalize → 不denormalize · DeepSeek收到什么名就回什么名
      //   官方API: LSP别名透传 · DeepSeek也应透传
      const _lspName = _rawName;
      return {
        id: tc.id || tc.call_id || `tc_${i}`, // ★ v10.0 · 修法⑨ · 工具调用 id 必传
        name: _lspName,
        argumentsJson: proxyManagedExecution
          ? _normalizeWorkspaceToolCall(
              _rawName,
              tc.function?.arguments || tc.argumentsJson || "{}",
              workspaceContext,
            )
          : tc.function?.arguments || tc.argumentsJson || "{}",
        // ★ v9.9.93 · 修法⑧ · isCustomToolCall: 仅代理执行类工具且 LSP 未发才标记
        //   trajectory_search 等即使 LSP 未发 → isCustomToolCall=false → LSP 正常执行
        //   道义: 十七章「太上不知有之」· LSP 不知有代理 · 工具调用自然流转
        isCustomToolCall:
          proxyManagedExecution &&
          _isProxyExecTool(
            _rawName,
            tc.function?.arguments || tc.argumentsJson,
          ) &&
          !(lspToolNames && lspToolNames.has(_rawName)),
      };
    });
    // ★ v10.1 · 修法⑰ (同 _flushTools) · ask_user_question 独占一轮 (终止性交互)
    //   非流式/缓冲路径同样隔离: 含 ask_user_question 即只保留它, 丢弃同轮兄弟
    //   工具 → 对齐官方"单发即停" → 弹窗正常弹出. 详见 _flushTools 处实证记述.
    let _emitCalls = mappedCalls;
    const _askI = mappedCalls.findIndex((c) => c.name === "ask_user_question");
    if (proxyManagedExecution && _askI >= 0 && mappedCalls.length > 1) {
      const _dropped = mappedCalls
        .filter((c) => c.name !== "ask_user_question")
        .map((c) => c.name);
      _emitCalls = [mappedCalls[_askI]];
      _routeDiag(
        "buffered tool_calls: ask_user_question 独占本轮 (终止性交互) → 丢弃同轮工具=" +
          _dropped.join(","),
      );
    }
    if (w.encodeChatToolCall) {
      const inner = Buffer.concat([
        _hdr(), // ★ message_id + timestamp
        ..._emitCalls.map((tc) =>
          w.encodeMessage(w.RSP.DELTA_TOOL_CALLS, w.encodeChatToolCall(tc)),
        ),
      ]);
      const fr = w.buildFrame(0, inner);
      if (fr && fr.length) {
        res.write(fr);
        _markFirstVisible(workspaceContext, "tool");
      }
    }
  }

  // ★ v9.9.99 · stop reason · 统一使用 finishReason 变量
  let stopReason = w.STOP_END;
  if (
    finishReason === "tool_calls" ||
    finishReason === "function_call" ||
    finishReason === "tool_use"
  )
    stopReason = w.STOP_TOOL_CALLS;
  else if (finishReason === "length") stopReason = w.STOP_MAX_TOKENS;
  else if (finishReason === "content_filter") stopReason = w.STOP_ERROR; // ★ v10.0 · 修法⑩补 · Go EXE: content_filter → ERROR(13)

  {
    const parts = [];
    parts.push(_hdr()); // ★ message_id + timestamp
    parts.push(w.encodeUint(w.RSP.STOP_REASON, stopReason));
    const fr = w.buildFrame(0, Buffer.concat(parts));
    if (fr && fr.length) res.write(fr);
  }

  // 结束帧
  if (w.buildEndFrame) {
    const fr = w.buildEndFrame(null);
    if (fr && fr.length) res.write(fr);
  }
  // ★ v9.9.78 · 移除 HTTP/2 trailers · EOS 帧已含 grpc-status:0
  //   v9.9.77 添加 addTrailers 是错误方向 · 与 EOS 帧重复
  //   Connect-RPC 规范: EOS 帧 IS the trailer delivery mechanism
  //   道义: 损之又损以至于无为 · 无为而无以为
  if (!res.writableEnded) res.end();
  if (
    protocol === "openai-responses" &&
    _adapters &&
    workspaceContext &&
    workspaceContext._responsesContinuationKey &&
    continuationItems.length > 0
  ) {
    _adapters
      .adapterFor("openai-responses")
      .commitContinuation(
        workspaceContext._responsesContinuationKey,
        continuationItems,
      );
  }
  _log(
    `[dao-router] unary ✓ text=${Buffer.byteLength(msg.content || "")}B tools=${(msg.tool_calls || []).length} actualModelUid=${_actualModelUid} outputId=${_outputId}`,
  );

  // ★ Token 追踪: unary 路径同样回传 tokenCount → _recordUsage 可聚合 (含缓存命中)
  return {
    tokenCount: {
      usageObserved: usageInfo != null,
      input: (usageInfo && (usageInfo.input || usageInfo.prompt_tokens)) || 0,
      output:
        (usageInfo && (usageInfo.output || usageInfo.completion_tokens)) || 0,
      cached:
        (usageInfo &&
          (usageInfo.cached ||
            usageInfo.prompt_tokens_details?.cached_tokens ||
            usageInfo.prompt_cache_hit_tokens)) ||
        0,
      cacheWrite: (usageInfo && usageInfo.cacheWrite) || 0,
    },
  };
}

/**
 * OpenAI SSE 流 → Cascade Connect-RPC wire 帧
 * 支持: text / thinking / tool_calls / stop_reason / end
 */
function _streamOaToCascade(
  agRes,
  res,
  w,
  modelUid,
  lspToolNames,
  toolAliasMap,
  protocol,
  localWorkspaceFallback = false,
  workspaceContext = null,
) {
  const toolBuf = new Map(); // index → { id, name, argsBuf }
  let buf = "";
  let stopReason = null;
  let textBytes = 0,
    thinkBytes = 0,
    toolCount = 0;
  // ★ v9.9.72a · actual_model_uid + output_id + request_id
  const _outputId = `dao_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const _requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const _actualModelUid = modelUid || "deepseek-chat";
  let _sentMetadata = false; // 只发一次

  // ★ v9.9.78 · message_id + timestamp · 官方后端每帧必含
  //   实证: 官方后端每帧 payload 均含 field 1 (message_id) + field 2 (timestamp)
  //   无 message_id → LSP 无法关联帧 → "Encountered unexpected error"
  //   道义: 三十九章「得一」· 得 message_id + timestamp 方能宁
  const _messageId =
    "bot-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10);
  const _hdr = () => w.buildFrameHeader(_messageId, Date.now());

  // ★ v9.9.87 · 累积器: 保留 thinking/text 内容用于内部重试消息
  //   v9.9.86 帧缓冲导致 LSP 10秒无数据 → 超时断开 (aborted) ❌
  //   正确策略: 直接写入帧 (LSP 需要持续数据流), 保留累积器用于重试
  //   LSP 看到两段 thinking 是正常的: 思考→调用工具→继续思考→回答
  //   道义: 三十七章「道恒无为」· 无为而无不為 · 不缓冲方能流
  let _textAccum = ""; // 累积的文本内容 (用于重试消息)
  let _thinkAccum = ""; // 累积的 thinking 内容 (用于重试消息)

  // ★ v9.9.88 · Token 追踪 (移植自 EXE StreamProcessor)
  //   从 SSE 流中提取 usage 信息 · 诊断日志记录
  //   道义: 十六章「万物旁作 吾以观其复也」· 观其所耗方知所节
  let _tokenCount = {
    usageObserved: false,
    input: 0,
    output: 0,
    cached: 0,
    cacheWrite: 0,
  };
  const _proxyManagedExecution = !!(
    workspaceContext && workspaceContext._proxyManagedExecution
  );
  const _responseItems = [];
  let _responsesStreamError = null;

  // ★ v9.9.85 · 服务端工具拦截: 分离 LSP 工具和服务端工具
  //   LSP 工具: LSP 有执行器 → 正常转发
  //   服务端工具: LSP 无执行器 → 拦截 → 代理执行 → 内部重试 → LSP 无感
  //   道义: 十七章「功述身芮」· 功成而身退 · LSP 不知有之
  //   太上不知有之 → 服务端工具调用对 LSP 完全透明
  const _serverSideCalls = []; // 拦截的服务端工具调用
  const _lspSideCalls = []; // 转发给 LSP 的工具调用

  const _flushTools = () => {
    if (toolBuf.size === 0) return;
    const allCalls = [];
    Array.from(toolBuf.keys())
      .sort((a, b) => a - b)
      .forEach((k) => {
        const r = toolBuf.get(k);
        if (r && r.name) {
          allCalls.push({
            id: r.id || `tc_${k}`,
            name: r.name.trim(),
            argumentsJson: r.argsBuf || "{}",
          });
        }
      });
    toolBuf.clear();

    // ★ v10.0 · 修法⑪ · 工具调用规范化 + 验证 + 去重
    //   移植自 Go EXE normalizeToolInvocation + deduplicateToolCalls
    //   道义: 十四章「执古之道以御今之有」· 规范方能御
    const _seen = new Set();
    const _dedupedCalls = [];
    for (const tc of allCalls) {
      if (!_proxyManagedExecution) {
        _dedupedCalls.push(tc);
        continue;
      }
      // 参数 JSON 验证: 确保是合法 JSON
      let _validArgs = tc.argumentsJson || "{}";
      try {
        JSON.parse(_validArgs);
      } catch {
        _log(`[dao-router] ⚠️ 工具调用参数JSON无效: ${tc.name} → 使用空对象`);
        _validArgs = "{}";
      }
      _validArgs = _normalizeWorkspaceToolCall(
        tc.name,
        _validArgs,
        workspaceContext,
      );
      // 去重: name + args 组合键 (Go EXE: toolName + ':' + JSON.stringify(params))
      const _dedupKey = tc.name + ":" + _validArgs;
      if (_seen.has(_dedupKey)) {
        _log(`[dao-router] ⚠️ 去重工具调用: ${tc.name}`);
        continue;
      }
      _seen.add(_dedupKey);
      _dedupedCalls.push({ ...tc, argumentsJson: _validArgs });
    }

    // ★ v10.1 · 修法⑰ · ask_user_question 独占一轮 (终止性交互 · 对齐官方)
    //   逆向实证 (zhoumac Pro 机 · D:\Devin\...\windsurf\dist\extension.js):
    //     官方弹窗由 LSP 把 chat 层 ask_user_question 工具调用转为 cortex 层
    //     RequestedInteraction{ask_user_question: CascadeAskUserQuestionInteractionSpec}
    //     (CortexStep field no:56 requested_interaction) → 渲染阻塞式弹窗.
    //   官方模型问问题时 *单发* ask_user_question 即停 (终止性, 问完等用户);
    //   外接模型常把它与 multi_edit/read_file 等同轮打包发出 (实证 _router_diag:
    //     "_flushTools total=2 names=ask_user_question,multi_edit") → LSP 把整批
    //   当普通工具执行, ask_user_question 不触发弹窗, 对话无感继续 → 用户实测
    //   "外接 API 弹不出弹窗, 只有官方模型才行" 之根因.
    //   故: 本轮一旦含 ask_user_question, 只保留它, 丢弃同轮兄弟工具, 令其独占
    //   成终止性交互 → 对齐官方"单发即停"路径 → 弹窗正常弹出. 被丢弃的工具不
    //   重放: 用户应答后模型自会重新规划 (官方语义本即 ask 为终止步, 不并骛).
    //   道义: 二十四章「企者不立 跨者不行」· 一事一时 · 问则专问.
    const _askIdx = _dedupedCalls.findIndex(
      (c) => c.name === "ask_user_question",
    );
    if (_proxyManagedExecution && _askIdx >= 0 && _dedupedCalls.length > 1) {
      const _askCall = _dedupedCalls[_askIdx];
      const _dropped = _dedupedCalls
        .filter((c) => c.name !== "ask_user_question")
        .map((c) => c.name);
      _dedupedCalls.length = 0;
      _dedupedCalls.push(_askCall);
      _routeDiag(
        "_flushTools: ask_user_question 独占本轮 (终止性交互) → 丢弃同轮工具=" +
          _dropped.join(","),
      );
    }

    // ★ v9.9.93 · 修法⑧ · 工具分类: LSP有执行器 → 透传 · 仅代理 → 拦截
    //   旧逻辑: _serverToolNames.has(name) && !lspToolNames.has(name)
    //   问题: trajectory_search 在 _serverToolNames 但 LSP 有执行器 → 被错误拦截
    //   新逻辑: 仅 _proxyOnlyToolNames 中的工具才拦截 → 其余全部透传 LSP
    //   道义: 十七章「太上不知有之」· LSP 不知有代理 · 工具调用自然流转
    for (const tc of _dedupedCalls) {
      if (!_proxyManagedExecution) {
        _lspSideCalls.push({ ...tc, isCustomToolCall: false });
        continue;
      }
      const missingRequiredArgs = _missingRequiredToolArgs(tc, lspToolNames);
      if (missingRequiredArgs.length > 0) {
        const validationError =
          `[TOOL_ARGUMENT_ERROR] ${tc.name} was not sent to the editor because required arguments are missing or empty: ` +
          `${missingRequiredArgs.join(", ")}. Reissue the same tool with every required field, including the exact file path and complete edit payload.`;
        _serverSideCalls.push({
          ...tc,
          validationError,
          missingRequiredArgs,
        });
        _routeDiag(
          `_flushTools: intercepted invalid ${tc.name} missing=${missingRequiredArgs.join(",")}`,
        );
        continue;
      }
      const isLocalWorkspaceTool = _shouldInterceptLocalWorkspaceTool(
        tc.name,
        tc.argumentsJson,
        localWorkspaceFallback,
        workspaceContext && workspaceContext._workspaceRoots,
      );
      const isProxyOnlyTool =
        isLocalWorkspaceTool ||
        (_isProxyExecTool(tc.name, tc.argumentsJson) &&
          !(lspToolNames && lspToolNames.has(tc.name)));
      if (isProxyOnlyTool) {
        // 仅代理工具: LSP 无执行器 → 拦截 → 代理执行后内部重试
        _serverSideCalls.push(tc);
        _log(
          `[dao-router] ⚡ 拦截仅代理工具: ${tc.name} args=${(tc.argumentsJson || "").substring(0, 120)}`,
        );
      } else {
        // LSP 工具 (含 LSP 有执行器的补充工具): 正常转发
        // ★ v9.9.101 · 太上下知有之 · 不反规范化 · 工具名直接透传
        //   不normalize → 不denormalize · 官方API透传 · DeepSeek也应透传
        const _lspName = tc.name;
        // ★ v9.9.93 · isCustomToolCall 判定: 仅代理工具且 LSP 未发 → true
        //   trajectory_search 等即使 LSP 未发 → isCustomToolCall=false → LSP 正常执行
        const _isCustom =
          _isProxyExecTool(tc.name, tc.argumentsJson) &&
          !(lspToolNames && lspToolNames.has(tc.name));
        _lspSideCalls.push({
          ...tc,
          name: _lspName,
          isCustomToolCall: _isCustom,
        });
      }
    }

    // ★ 诊断: 记录所有工具调用名称
    if (_dedupedCalls.length > 0) {
      _routeDiag(
        "_flushTools: total=" +
          _dedupedCalls.length +
          " (raw=" +
          allCalls.length +
          ")" +
          " serverSide=" +
          _serverSideCalls.length +
          " lspSide=" +
          _lspSideCalls.length +
          " names=" +
          _dedupedCalls.map((c) => c.name).join(","),
      );
    }

    // ★ v9.9.87 · LSP 工具调用帧: 有服务端工具时不写入 res (重试后可能变化)
    //   无服务端工具时直接写入 res (正常流程)
    //   有服务端工具时, LSP 工具调用信息保存在 _lspSideCalls → 供重试使用
    //   重试后, 新的 _streamOaToCascade 会写入最终的 LSP 工具调用帧
    //   道义: 三十七章「道恒无为」· 有无相生 · 缓急有序
    if (_lspSideCalls.length > 0 && w.encodeChatToolCall) {
      const _dispatchNativeBeforeLocalRetry =
        localWorkspaceFallback === "grep-only" &&
        _serverSideCalls.length > 0 &&
        _serverSideCalls.every((tc) =>
          _grepOnlyLocalWorkspaceToolNames.has(String(tc.name || "")),
        );
      if (_serverSideCalls.length === 0 || _dispatchNativeBeforeLocalRetry) {
        // 无服务端工具 → 直接写入 LSP 工具调用帧
        const inner = Buffer.concat([
          _hdr(),
          ..._lspSideCalls.map((tc) =>
            w.encodeMessage(w.RSP.DELTA_TOOL_CALLS, w.encodeChatToolCall(tc)),
          ),
        ]);
        const fr = w.buildFrame(0, inner);
        if (fr && fr.length) {
          res.write(fr);
          toolCount += _lspSideCalls.length;
          _markFirstVisible(workspaceContext, "tool");
        }
        if (_dispatchNativeBeforeLocalRetry) {
          _routeDiag(
            `_flushTools native-lsp-priority: dispatching ${_lspSideCalls.length} LSP call(s) before local retry`,
          );
        }
      }
      // 有服务端工具 → 不写入 LSP 工具调用帧 → 等待重试后的新响应
    }
  };

  // ★ v9.9.99 → v10.0 · 协议感知 SSE 解析 (三协议)
  //   Anthropic: event: xxx\ndata: {json}\n\n → parseSSELine(data, eventType)
  //   OpenAI Chat: data: {json}\n\n → parseSSELine(data)
  //   OpenAI Responses: data: {json}\n\n → parseSSELine(data, eventType)
  //   道义: 二十八章「知其白 守其辱 为天下式」· 知各协议之白 · 守其转换之辱
  const _isAnthropic = protocol === "anthropic";
  const _isResponses = protocol === "openai-responses";
  const _isGemini = protocol === "gemini";
  const _anthAdapter =
    _isAnthropic && _adapters ? _adapters.adapterFor("anthropic") : null;
  const _chatAdapter =
    !_isAnthropic && !_isResponses && !_isGemini && _adapters
      ? _adapters.adapterFor("openai-chat")
      : null;
  const _respAdapter =
    _isResponses && _adapters ? _adapters.adapterFor("openai-responses") : null;
  const _gemAdapter =
    _isGemini && _adapters ? _adapters.adapterFor("gemini") : null;
  let _sseEventType = ""; // ★ Anthropic/Responses SSE event type 追踪

  return new Promise((resolve, reject) => {
    // ★ v10.2 · 修法⑧ · 主流式空闲保活 (对齐重试路径 keepalive · 防"无征兆中断")
    //   逆向实证 (zhoumac Pro 机): 主流式 _streamOaToCascade 仅在收到上游数据时写帧.
    //   若外接模型中途静默 >~10s (慢推理 / token 间隙 / 网络抖动但 socket 未报错),
    //   则无帧可写, agRes 'error' 不触发, LSP 客户端约 10s 无新数据即 abort →
    //   "对话毫无征兆中断" (他用户反馈) 之潜在根因. 上游 *报错* 已由 agRes.on('error')
    //   优雅 STOP_END 兜底; 此处补的是上游 *静默不报错* 的缺口. 与重试路径
    //   (setInterval 5s DELTA_THINKING) 同法: 空闲达阈值即补发一帧 thinking 保活,
    //   收到真实数据即复位; 流结束/出错即清除. unref 不阻进程退出.
    //   道义: 五十二章「守柔曰强」· 守流不绝则不断.
    let _lastUpstreamTs = Date.now();
    const _IDLE_KEEPALIVE_MS =
      Number(process.env.DAO_IDLE_KEEPALIVE_MS) || 5000;
    const _IDLE_CHECK_MS = Math.max(
      200,
      Math.min(2000, Math.floor(_IDLE_KEEPALIVE_MS / 2)),
    );
    const _idleKeepalive = setInterval(() => {
      try {
        if (res.writableEnded) return;
        if (Date.now() - _lastUpstreamTs < _IDLE_KEEPALIVE_MS) return;
        const kaParts = [_hdr()];
        if (!_sentMetadata) {
          _sentMetadata = true;
          kaParts.push(w.encodeString(w.RSP.ACTUAL_MODEL_UID, _actualModelUid));
          kaParts.push(w.encodeString(w.RSP.OUTPUT_ID, _outputId));
          kaParts.push(w.encodeString(w.RSP.REQUEST_ID, _requestId));
        }
        const kaFr = w.buildFrame(0, Buffer.concat(kaParts));
        if (kaFr && kaFr.length && !res.writableEnded) res.write(kaFr);
        _lastUpstreamTs = Date.now();
        _routeDiag(
          "_streamOaToCascade idle-keepalive: metadata-only frame sent",
        );
      } catch (_kaErr) {
        _routeDiag(
          "_streamOaToCascade idle-keepalive FAILED: " + _kaErr.message,
        );
      }
    }, _IDLE_CHECK_MS);
    if (_idleKeepalive.unref) _idleKeepalive.unref();
    const _clearIdleKeepalive = () => {
      try {
        clearInterval(_idleKeepalive);
      } catch {}
    };

    agRes.on("data", (chunk) => {
      _lastUpstreamTs = Date.now(); // ★ v10.2 · 收到上游数据 → 复位空闲计时
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop();

      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        // ★ v9.9.99 → v10.0 · Anthropic/Responses SSE: 追踪 event type
        if (
          (_isAnthropic || _isResponses || _isGemini) &&
          line.startsWith("event:")
        ) {
          _sseEventType = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (!d || d === "[DONE]") continue;

        // ★ v9.9.99 → v10.0 · 协议分发: Anthropic / OpenAI Responses / OpenAI Chat
        let delta, finishReason, usageInfo;

        if (_isAnthropic && _anthAdapter) {
          // ── Anthropic SSE 解析 ──
          const parsed = _anthAdapter.parseSSELine(d, _sseEventType);
          if (!parsed || parsed.type === "skip") continue;
          // ★ v10.0 · 修法⑯ · message_stop → done → 显式跳过
          //   finishReason 已由 message_delta 设置 · done 仅标记流结束
          if (parsed.type === "done") {
            finishReason = finishReason || "stop";
            continue;
          }
          delta = {
            content: parsed.content || null,
            reasoning_content: parsed.thinking || null,
          };
          finishReason = parsed.finishReason || null;
          usageInfo = parsed.usage || null;

          // Anthropic tool calls
          if (parsed.toolCallStart) {
            const tc = parsed.toolCallStart;
            if (!toolBuf.has(tc.index))
              toolBuf.set(tc.index, { id: tc.id, name: tc.name, argsBuf: "" });
          }
          if (parsed.toolCallDelta) {
            const td = parsed.toolCallDelta;
            const existing = toolBuf.get(td.index);
            if (existing) existing.argsBuf += td.partialJson || "";
          }
          if (parsed.toolCalls) {
            for (const tc of parsed.toolCalls) {
              const idx = toolBuf.size;
              toolBuf.set(idx, {
                id: tc.id,
                name: tc.function.name,
                argsBuf: tc.function.arguments || "{}",
              });
            }
          }
          // ★ v10.0 · content_block_stop → toolCallBlockDone
          //   Go EXE 在此事件时立即 emitToolCall → 我们等价调用 _flushTools
          //   道义: 九章「持而盈之不如其已」· 已则成 · 成则通
          if (parsed.toolCallBlockDone) {
            _flushTools();
          }
        } else if (_isResponses && _respAdapter) {
          // ── OpenAI Responses SSE 解析 ──
          //   道义: 四十一章「大方无隅 大器晚成」· 新格式无隅 · 晚成方通
          const parsed = _respAdapter.parseSSELine(d, _sseEventType);
          if (!parsed || parsed.type === "skip") continue;
          if (parsed.type === "error") {
            _responsesStreamError = parsed.error || {
              message: "Responses stream failed",
            };
            continue;
          }
          if (parsed.type === "done") {
            finishReason = finishReason || "stop";
            continue;
          }
          delta = {
            content: parsed.content || null,
            reasoning_content: parsed.thinking || null,
          };
          finishReason = parsed.finishReason || null;
          usageInfo = parsed.usage || null;
          if (parsed.responseItemDone) {
            _responseItems.push(parsed.responseItemDone);
          }
          if (Array.isArray(parsed.responseItems)) {
            _responseItems.length = 0;
            _responseItems.push(...parsed.responseItems);
          }

          // Responses API tool calls
          if (parsed.toolCallStart) {
            const tc = parsed.toolCallStart;
            if (!toolBuf.has(tc.index))
              toolBuf.set(tc.index, { id: tc.id, name: tc.name, argsBuf: "" });
          }
          if (parsed.toolCallDelta) {
            const td = parsed.toolCallDelta;
            const existing = toolBuf.get(td.index);
            if (existing) {
              existing.argsBuf += td.partialJson || "";
              // ★ v10.0 · 修法⑬ · callId 补填 (toolCallStart 可能无 id)
              if (td.callId && !existing.id) existing.id = td.callId;
            }
          }
          if (parsed.toolCallComplete) {
            // ★ Responses API 的 response.output_item.done 提供完整工具调用
            //   直接覆盖缓冲区中的记录 (确保参数完整)
            const tcc = parsed.toolCallComplete;
            const existing = toolBuf.get(tcc.index);
            if (existing) {
              if (tcc.id) existing.id = tcc.id;
              if (tcc.name) existing.name = tcc.name;
              if (tcc.arguments) existing.argsBuf = tcc.arguments;
            } else {
              toolBuf.set(tcc.index, {
                id: tcc.id || `tc_${tcc.index}`,
                name: tcc.name,
                argsBuf: tcc.arguments || "{}",
              });
            }
          }
        } else if (_isGemini && _gemAdapter) {
          const parsed = _gemAdapter.parseSSELine(d, _sseEventType);
          if (!parsed || parsed.type === "skip") continue;
          if (parsed.type === "done") {
            finishReason = finishReason || "stop";
            continue;
          }
          delta = {
            content: parsed.content || null,
            reasoning_content: parsed.thinking || null,
          };
          finishReason = parsed.finishReason || null;
          usageInfo = parsed.usage || null;
          if (Array.isArray(parsed.toolCalls)) {
            for (const tc of parsed.toolCalls) {
              const idx = toolBuf.size;
              toolBuf.set(idx, {
                id: tc.id || `tc_${idx}`,
                name: tc.function?.name || "",
                argsBuf: tc.function?.arguments || "{}",
              });
            }
          }
        } else if (_chatAdapter) {
          // ── OpenAI Chat SSE 解析 (统一走 adapter) ──
          //   道义: 二十八章「知其白守其辱为天下式」· 三协议同一式
          const parsed = _chatAdapter.parseSSELine(d);
          if (!parsed || parsed.type === "skip") continue;
          if (parsed.type === "done") {
            finishReason = finishReason || "stop";
            continue;
          }
          delta = {
            content: parsed.content || null,
            reasoning_content: parsed.thinking || null,
          };
          finishReason = parsed.finishReason || null;
          usageInfo = parsed.usage || null;

          // OpenAI Chat tool calls (增量式)
          if (Array.isArray(parsed.toolCalls)) {
            for (const tc of parsed.toolCalls) {
              const idx = typeof tc.index === "number" ? tc.index : 0;
              let rec = toolBuf.get(idx);
              if (!rec) {
                rec = { id: "", name: "", argsBuf: "" };
                toolBuf.set(idx, rec);
              }
              if (tc.id) rec.id = tc.id;
              if (tc.function && tc.function.name) rec.name = tc.function.name;
              if (tc.function && typeof tc.function.arguments === "string")
                rec.argsBuf += tc.function.arguments;
            }
          }
        } else {
          // ── 兜底: 无 adapter 可用时手工解析 ──
          let obj;
          try {
            obj = JSON.parse(d);
          } catch {
            continue;
          }
          const choice = obj.choices && obj.choices[0];
          if (!choice) continue;
          delta = choice.delta || {};
          finishReason = choice.finish_reason || null;
          usageInfo = obj.usage || null;
        }

        // ★ v9.9.79 · 首帧必发 metadata (message_id + timestamp + actual_model_uid + output_id + request_id)
        //   旧 v9.9.78 仅在首个文本时发 → 若模型先返回 tool_calls (无文本) → metadata 永远不发
        //   → LSP 缺 output_id/request_id → 工具调用关联失败
        //   道义: 三十九章「侯王得一以为天下正」· 得元数据方能正位
        if (!_sentMetadata) {
          _sentMetadata = true;
          const metaParts = [];
          metaParts.push(_hdr()); // ★ message_id + timestamp
          metaParts.push(
            w.encodeString(w.RSP.ACTUAL_MODEL_UID, _actualModelUid),
          );
          metaParts.push(w.encodeString(w.RSP.OUTPUT_ID, _outputId));
          metaParts.push(w.encodeString(w.RSP.REQUEST_ID, _requestId));
          const metaFr = w.buildFrame(0, Buffer.concat(metaParts));
          if (metaFr && metaFr.length) res.write(metaFr);
        }

        // 文本增量 · 含 message_id + timestamp
        if (typeof delta.content === "string" && delta.content.length > 0) {
          // ★ v9.9.87 · 文本帧直接写入 res + 累积文本
          const parts = [];
          parts.push(_hdr()); // ★ message_id + timestamp
          parts.push(w.encodeString(w.RSP.DELTA_TEXT, delta.content));
          const fr = w.buildFrame(0, Buffer.concat(parts));
          if (fr && fr.length) {
            res.write(fr);
            textBytes += Buffer.byteLength(delta.content);
            _textAccum += delta.content; // ★ 累积文本用于重试
            if (/\S/.test(delta.content)) {
              _markFirstVisible(workspaceContext, "text");
            }
          }
        }

        // 思考增量 · 含 message_id + timestamp
        const think =
          (typeof delta.reasoning_content === "string" &&
            delta.reasoning_content) ||
          (typeof delta.thinking === "string" && delta.thinking) ||
          (typeof delta.reasoning === "string" && delta.reasoning) ||
          "";
        if (think && !_EXPOSE_REASONING) {
          thinkBytes += Buffer.byteLength(think);
          _thinkAccum += think;
        }
        if (think && _EXPOSE_REASONING) {
          // ★ v9.9.87 · thinking 帧直接写入 res + 累积 thinking
          const parts = [];
          parts.push(_hdr()); // ★ message_id + timestamp
          parts.push(w.encodeString(w.RSP.DELTA_THINKING, think));
          const fr = w.buildFrame(0, Buffer.concat(parts));
          if (fr && fr.length) {
            res.write(fr);
            thinkBytes += Buffer.byteLength(think);
            _thinkAccum += think; // ★ 累积 thinking 用于重试
          }
        }

        // 工具调用 (累进)
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            let rec = toolBuf.get(idx);
            if (!rec) {
              rec = { id: "", name: "", argsBuf: "" };
              toolBuf.set(idx, rec);
            }
            if (tc.id) rec.id = tc.id;
            if (tc.function && tc.function.name) rec.name = tc.function.name;
            if (tc.function && typeof tc.function.arguments === "string")
              rec.argsBuf += tc.function.arguments;
          }
        }

        // ★ v9.9.99 · 结束信号 (统一: finishReason 变量)
        //   OpenAI Chat: choice.finish_reason → finishReason
        //   Anthropic: parsed.finishReason → finishReason
        if (finishReason) {
          _flushTools();
          const fr = finishReason;
          if (
            fr === "tool_calls" ||
            fr === "function_call" ||
            fr === "tool_use"
          )
            stopReason = w.STOP_TOOL_CALLS;
          else if (fr === "length") stopReason = w.STOP_MAX_TOKENS;
          else if (fr === "content_filter")
            stopReason = w.STOP_ERROR; // ★ v10.0 · 修法⑩ · Go EXE: content_filter → ERROR(13)
          else stopReason = w.STOP_END;
        }

        // ★ v9.9.88 · Token 追踪: 从 SSE usage 字段提取 token 计数
        //   v9.9.99 · 统一使用 usageInfo (OpenAI + Anthropic 均适用)
        //   道义: 十六章「万物旁作 吾以观其复也」· 观其所耗方知所节
        if (usageInfo) {
          _tokenCount.usageObserved = true;
          _tokenCount.input =
            usageInfo.input || usageInfo.prompt_tokens || _tokenCount.input;
          _tokenCount.output =
            usageInfo.output ||
            usageInfo.completion_tokens ||
            _tokenCount.output;
          // ★ 缓存命中 token (adapter 已归一: cached / 兜底手工解析取原始字段)
          _tokenCount.cached =
            usageInfo.cached ||
            usageInfo.prompt_tokens_details?.cached_tokens ||
            usageInfo.prompt_cache_hit_tokens ||
            _tokenCount.cached;
          _tokenCount.cacheWrite =
            usageInfo.cacheWrite || _tokenCount.cacheWrite;
        }
      }
    });

    agRes.on("end", () => {
      _clearIdleKeepalive(); // ★ v10.2 · 流结束 → 停保活
      // 兜底: 未发 finish_reason 时冲工具
      _flushTools();

      if (
        _isResponses &&
        _respAdapter &&
        workspaceContext &&
        workspaceContext._responsesContinuationKey &&
        _responseItems.length > 0
      ) {
        _respAdapter.commitContinuation(
          workspaceContext._responsesContinuationKey,
          _responseItems,
        );
      }

      if (
        _responsesStreamError &&
        textBytes === 0 &&
        thinkBytes === 0 &&
        toolCount === 0
      ) {
        const error = new Error(
          _responsesStreamError.message || "Responses stream failed",
        );
        error.code = _responsesStreamError.code || "responses_stream_error";
        reject(error);
        return;
      }

      // ★ v9.9.99 · 弹性自动继续 (移植自 Go resilience.shouldAutoContinue)
      //   道义: 三十七章「道恒无为」· 不绝则通 · 自动续流
      //   finishReason=length → 输出被截断 → 可自动追加 "继续" 重发
      //   当前: 仅记录日志 · 实际自动继续由 _tryRoute 的重试逻辑处理
      if (_resilience && stopReason === w.STOP_MAX_TOKENS) {
        const shouldContinue = _resilience.shouldAutoContinue("length", 0, 3);
        if (shouldContinue) {
          _log(
            "[dao-router] ★ resilience: finishReason=length → 可自动继续 (累积text可重发)",
          );
          _routeDiag(
            "_streamOaToCascade resilience: auto-continue candidate (length)",
          );
        }
      }

      // ★ v9.9.99 · 拒绝匹配检测 (移植自 Go resilience.matchesRefusal)
      //   道义: 三十六章「将欲弱之 必固强之」· 知其拒方知其通
      if (_resilience && _textAccum.length > 0) {
        if (_resilience.matchesRefusal(_textAccum)) {
          _log("[dao-router] ★ resilience: 检测到拒绝响应 → 可降级重试");
          _routeDiag("_streamOaToCascade resilience: refusal detected");
        }
      }

      // ★ v9.9.87 · 有服务端工具时: 不关闭流 → 等待内部重试
      //   v9.9.86 帧缓冲导致 LSP 超时断开 ❌
      //   v9.9.87 恢复直接写入 → LSP 已看到 thinking 帧 → 连接活跃
      //   重试后的新 thinking/text 也直接写入 → LSP 看到连续流 ✅
      //   道义: 三十七章「道恒无为」· 流不闭方能续 · 闭则割裂
      if (_serverSideCalls.length > 0) {
        // 有服务端工具 → 不发送 stop_reason/EOS/end → 等待 _tryRoute 重试
        _log(
          `[dao-router] stream ▶ text=${textBytes}B think=${thinkBytes}B tools=${toolCount} stopReason=${stopReason} serverSideIntercepted=${_serverSideCalls.length} → stream held open for retry`,
        );
        _routeDiag(
          "_streamOaToCascade end (held): text=" +
            textBytes +
            "B think=" +
            thinkBytes +
            "B tools=" +
            toolCount +
            " stopReason=" +
            stopReason +
            " serverSideIntercepted=" +
            _serverSideCalls.length +
            " model=" +
            _actualModelUid,
        );
        // ★ resolve 但不关闭流 → _tryRoute 会继续写入
        resolve({
          serverSideCalls: _serverSideCalls,
          lspSideCalls: _lspSideCalls, // ★ v9.9.87 · 返回 LSP 工具调用
          textBytes,
          thinkBytes,
          toolCount,
          stopReason,
          streamFinalized: false, // ★ 标记: 流未关闭
          textAccum: _textAccum, // ★ 累积文本 (用于重试消息)
          thinkAccum: _thinkAccum, // ★ 累积 thinking (用于重试消息)
          tokenCount: _tokenCount, // ★ v9.9.88 · Token 追踪
        });
        return; // ★ 不执行下面的 finalize 逻辑
      }

      // ★ 道法自然 · 防「上游干净结束却无 finish_reason → IDE 视为中断」
      //   部分渠道/代理在最后一帧不带 finish_reason、或缺 data:[DONE] 即收流;
      //   只要已有产出(text/think/tool) → 按正常结束补 STOP_END · 令本轮完整可继续。
      //   道义: 二十五章「周行而不殆」· 行至其终当善成 · 不令半途若断。
      if (
        stopReason === null &&
        (textBytes > 0 || thinkBytes > 0 || toolCount > 0)
      ) {
        stopReason = w.STOP_END;
        _log(
          "[dao-router] ★ 上游无 finish_reason 但有产出 → 补 STOP_END (防误判中断)",
        );
      }

      // 无正文亦无工具调用的回合对 Devin 等价于空回复: 即便上游携带
      // finish_reason 干净收尾(如仅返回 reasoning、或 completed 空 content)、
      // 直接封口会让任务无输出即结束。交给 _tryRoute 同渠道重试一次,
      // 仍为空再按渠道优先级切换。
      if (textBytes === 0 && toolCount === 0) {
        _routeDiag(
          `_streamOaToCascade empty response: no text/tools (think=${thinkBytes}B stop=${stopReason}) model=${_actualModelUid}`,
        );
        resolve({
          emptyResponse: true,
          streamFinalized: false,
          textBytes,
          thinkBytes,
          toolCount,
          stopReason,
          textAccum: _textAccum,
          thinkAccum: _thinkAccum,
          tokenCount: _tokenCount,
        });
        return;
      }

      // ★ 无服务端工具 → 正常关闭流
      // ★ v9.9.78 · stop_reason 帧含 message_id + timestamp
      if (stopReason !== null) {
        const parts = [];
        parts.push(_hdr()); // ★ message_id + timestamp
        parts.push(w.encodeUint(w.RSP.STOP_REASON, stopReason));
        const fr = w.buildFrame(0, Buffer.concat(parts));
        if (fr && fr.length) res.write(fr);
      }
      if (w.buildEndFrame) {
        const fr = w.buildEndFrame(null);
        if (fr && fr.length) res.write(fr);
      }
      if (!res.writableEnded) res.end();
      _log(
        `[dao-router] stream ✓ text=${textBytes}B think=${thinkBytes}B tools=${toolCount} stopReason=${stopReason} tokens=${_tokenCount.input}+${_tokenCount.output} serverSideIntercepted=0`,
      );
      _routeDiag(
        "_streamOaToCascade end: text=" +
          textBytes +
          "B think=" +
          thinkBytes +
          "B tools=" +
          toolCount +
          " stopReason=" +
          stopReason +
          " serverSideIntercepted=" +
          _serverSideCalls.length +
          " model=" +
          _actualModelUid,
      );
      // ★ v9.9.85b · 返回拦截信息 → _tryRoute 可据此做内部重试
      resolve({
        serverSideCalls: _serverSideCalls,
        textBytes,
        thinkBytes,
        toolCount,
        stopReason,
        tokenCount: _tokenCount, // ★ v9.9.88 · Token 追踪
      });
    });

    agRes.on("error", (e) => {
      _clearIdleKeepalive(); // ★ v10.2 · 出错 → 停保活
      _flushTools();
      // ★ 道法自然 · 优雅中断恢复 (修「对话对一半就断、无法继续」核心)
      //   上游 socket 中途断流(ECONNRESET/代理超时/proxy premature close)时,
      //   若本轮已产出内容 → 按【正常结束 STOP_END】封口, 令 IDE 拿到一段完整、
      //   可在其上继续追问的回答, 而非抛硬错误使整轮中断、无法继续。
      //   仅当【零产出】(刚发起就断) 才回硬错误。
      //   道义: 七十八章「天下莫柔弱於水 而攻堅強者莫之能勝」· 遇断不折 · 顺势成全。
      const _hadOutput =
        (_textAccum && _textAccum.length > 0) ||
        (_thinkAccum && _thinkAccum.length > 0) ||
        _serverSideCalls.length > 0 ||
        _lspSideCalls.length > 0;
      if (_hadOutput) {
        _log(
          `[dao-router] ⚠ 上游流中断(${e.message}) · 已产出 text=${(_textAccum || "").length}B → 优雅封口 STOP_END(本轮可继续)`,
        );
        _routeDiag("_streamOaToCascade upstream-interrupt → graceful STOP_END");
        try {
          const parts = [];
          parts.push(_hdr());
          parts.push(w.encodeUint(w.RSP.STOP_REASON, w.STOP_END));
          const fr = w.buildFrame(0, Buffer.concat(parts));
          if (fr && fr.length && !res.writableEnded) res.write(fr);
        } catch {}
        if (w.buildEndFrame) {
          try {
            const ef = w.buildEndFrame(null);
            if (ef && ef.length && !res.writableEnded) res.write(ef);
          } catch {}
        }
        if (!res.writableEnded) res.end();
        resolve({
          serverSideCalls: _serverSideCalls,
          lspSideCalls: _lspSideCalls,
          textBytes: (_textAccum || "").length,
          thinkBytes: (_thinkAccum || "").length,
          toolCount: _serverSideCalls.length + _lspSideCalls.length,
          stopReason: w.STOP_END,
          interrupted: true,
          textAccum: _textAccum,
          thinkAccum: _thinkAccum,
          tokenCount: _tokenCount,
        });
        return;
      }
      // Zero-output failures must leave the downstream Connect stream open so
      // route() can try the next user-configured channel in the same turn.
      reject(e);
    });
  });
}

/**
 * 获取 substitute 模式的目标 UID (provider="substitute")
 * @returns {string|null} 目标 Cascade model UID，null=不是substitute模式
 */
function getSubstitution(modelUid) {
  const t = _routes[_normalizeModelUid(modelUid)];
  if (!t || t.provider !== "substitute") return null;
  return t.model || null;
}

/**
 * patchModelUid — 替换 ConnectRPC 帧里 protobuf field 21 (chat_model_uid)
 *
 * 帧格式: [1B flags][4B BE length][protobuf body]
 * field 21, wire type 2: tag=[0xAA, 0x01], length varint, UTF-8 bytes
 *
 * @param {Buffer}  rawBody - ConnectRPC 原始帧 (可能含多帧)
 * @param {boolean} isJSON  - true=JSON格式(非protobuf) → 直接字符串替换
 * @param {string}  oldUid  - 原 modelUid
 * @param {string}  newUid  - 目标 modelUid
 * @returns {Buffer|null} 修改后的 Buffer，失败返回 null
 */
function patchModelUid(rawBody, isJSON, oldUid, newUid) {
  if (!rawBody || !rawBody.length) return null;
  const normalizedOld = _normalizeModelUid(oldUid);
  if (normalizedOld === newUid) return rawBody;

  try {
    if (isJSON) {
      // JSON 格式：直接字符串替换 modelUid 字段
      const s = rawBody.toString("utf8");
      // 精确匹配 "modelUid":"OLD" 或 "model_uid":"OLD"
      const patched = s
        .replace(
          new RegExp(`"modelUid"\\s*:\\s*"${_escRe(oldUid)}"`, "g"),
          `"modelUid":"${newUid}"`,
        )
        .replace(
          new RegExp(`"model_uid"\\s*:\\s*"${_escRe(oldUid)}"`, "g"),
          `"model_uid":"${newUid}"`,
        );
      if (patched === s) return null; // 未找到
      // 更新帧长度（5字节头）
      const newPb = Buffer.from(patched, "utf8");
      const hdr = Buffer.alloc(5);
      hdr[0] = rawBody[0];
      hdr.writeUInt32BE(newPb.length - 5, 1);
      return newPb;
    }

    // Binary protobuf 格式
    // ConnectRPC frame: [1B flags][4B length][protobuf]
    if (rawBody.length < 5) return null;
    const flags = rawBody[0];
    const pbLen = rawBody.readUInt32BE(1);
    if (rawBody.length < 5 + pbLen) return null;
    const rawPb = rawBody.slice(5, 5 + pbLen);

    // flags=1 表示 gzip 压缩，需要解压
    let pb = rawPb;
    let isCompressed = false;
    if (flags === 1) {
      try {
        pb = zlib.gunzipSync(rawPb);
        isCompressed = true;
      } catch {
        return null;
      }
    }

    const oldBytes = Buffer.from(oldUid, "utf8");
    const newBytes = Buffer.from(newUid, "utf8");

    // ── 策略一: 标准 field 21 tag [0xAA, 0x01] 扫描 ─────────────
    // field 21, wire type 2: tag = (21<<3|2) = 170 = [0xAA, 0x01]
    const TAG1 = 0xaa,
      TAG2 = 0x01;
    let pos = 0;
    while (pos < pb.length - 1) {
      if (pb[pos] !== TAG1 || pb[pos + 1] !== TAG2) {
        pos++;
        continue;
      }
      let len = 0,
        shift = 0,
        i = pos + 2;
      while (i < pb.length) {
        const b = pb[i++];
        len |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      }
      if (
        i + len <= pb.length &&
        pb.slice(i, i + len).toString("utf8") === oldUid
      ) {
        const lenVarNew = _encodeVarint(newBytes.length);
        const newPb = Buffer.concat([
          pb.slice(0, pos),
          Buffer.from([TAG1, TAG2]),
          lenVarNew,
          newBytes,
          pb.slice(i + len),
        ]);
        return _repackFrame(newPb, isCompressed, flags, rawBody, 5 + pbLen);
      }
      pos++;
    }

    // ── 策略二: 原始字节串搜索 (处理不同的 tag 编码格式) ──────────
    // 找 length_varint + oldUid_bytes，不强求具体 tag
    const lenVar = _encodeVarint(oldBytes.length);
    const pattern = Buffer.concat([lenVar, oldBytes]);
    let idx = pb.indexOf(pattern);
    while (idx >= 0) {
      // 验证这个位置之前有 protobuf tag 字节 (至少1字节)
      if (idx >= 1) {
        const lenVarNew = _encodeVarint(newBytes.length);
        const replacement = Buffer.concat([lenVarNew, newBytes]);
        const newPb = Buffer.concat([
          pb.slice(0, idx),
          replacement,
          pb.slice(idx + pattern.length),
        ]);
        return _repackFrame(newPb, isCompressed, flags, rawBody, 5 + pbLen);
      }
      idx = pb.indexOf(pattern, idx + 1);
    }
    return null; // 未找到 field 21
  } catch {
    return null;
  }
}

/**
 * 重新打包 ConnectRPC 帧：如果原帧是压缩的，重新 gzip 压缩
 * @param {Buffer}  newPb       - patch 后的 (解压) protobuf bytes
 * @param {boolean} isCompressed - 原帧是否压缩
 * @param {number}  flags       - 原 flags 字节
 * @param {Buffer}  rawBody     - 原始完整 body
 * @param {number}  tailStart   - 后续帧起始位置 (5 + pbLen)
 */
function _repackFrame(newPb, isCompressed, flags, rawBody, tailStart) {
  let payload = newPb;
  if (isCompressed) {
    try {
      payload = zlib.gzipSync(newPb);
    } catch {
      return null;
    }
  }
  const newHdr = Buffer.alloc(5);
  newHdr[0] = flags; // 保持原 flags (压缩位)
  newHdr.writeUInt32BE(payload.length, 1);
  return Buffer.concat([newHdr, payload, rawBody.slice(tailStart)]);
}

function _escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function _encodeVarint(n) {
  const parts = [];
  while (n >= 128) {
    parts.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  parts.push(n & 0x7f);
  return Buffer.from(parts);
}

/** 清空健康缓存 · 供热重载时强制重新探测 */
function resetHealthCache() {
  for (const k of Object.keys(_healthCache)) {
    delete _healthCache[k];
  }
  _upstreamCircuits.clear();
  _log("[dao-router] 健康缓存已清空");
}

/**
 * 拼出 provider 的模型列表 URL · 防 baseUrl 已含 /vN 时重复拼 /v1 → /v1/v1/models 404
 *   道义: 二十二章「曲则全」· baseUrl 多形(含/不含版本段) · 归一方得真路
 */
// ★ cc-switch 风 · 渠道地址归一: baseUrl 末若含补全路径则剥离 · 防双重路径
//   道义: 二十二章「曲则全」· 多形归一方得真路
//   实证根因: 小米 baseUrl=https://api.xiaomimimo.com/v1/chat/completions
//     + completionPath=/v1/chat/completions → 拼成
//     .../v1/chat/completions/v1/chat/completions → 404 → 渠道完全不可用。
//   归一: 剥去 baseUrl 末尾补全后缀(含可选 /vN) · 仅留真根 · 再由 completionPath 单次拼接。
const _COMPLETION_SUFFIX_RE =
  /\/(?:v\d+\/)?(?:chat\/completions|completions|messages|responses)\/?$/i;
function _stripCompletionSuffix(u) {
  let s = String(u || "").replace(/\/+$/, "");
  s = s.replace(_COMPLETION_SUFFIX_RE, "");
  return s.replace(/\/+$/, "");
}
// 真根 + completionPath 单次拼接 (剥去 base 误含的补全后缀 · 幂等)
function _joinCompletionUrl(base, completionPath) {
  const root = _stripCompletionSuffix(base);
  let p = completionPath || "/v1/chat/completions";
  if (!p.startsWith("/")) p = "/" + p;
  return root + p;
}

// ★ cc-switch build_models_url_candidates 移植 · 多候选顺序探测 /models
//   道义: 四十八章「为道日损」· 候选有序 · 逐一损去不通之路 · 至于得真
//   不着相于单一 URL · 万物并育而不相害 · 任意渠道皆可自动解全量模型
function _modelsUrlCandidates(cfg) {
  const raw = String(cfg.baseUrl || _gatewayUrl).replace(/\/+$/, "");
  const out = [];
  const push = (x) => {
    if (x && out.indexOf(x) < 0) out.push(x);
  };
  // 0. 用户显式 modelsUrl 优先
  if (cfg.modelsUrl) push(String(cfg.modelsUrl).replace(/\/+$/, ""));
  // 1. 先剥补全后缀得真根 (修小米类「全路径 baseUrl」)
  const root = _stripCompletionSuffix(raw);
  // ★ 渠特模表端 (优先) · GitHub Models 目录 / Gemini 原生 / Anthropic limit
  //   道: 上善若水 · 处众人之所恶 · 各家底层皆自适
  try {
    const _h = new URL(
      root.includes("://") ? root : "https://" + root,
    ).hostname.toLowerCase();
    const _isAnthropicHost =
      cfg.protocol === "anthropic" ||
      cfg.type === "anthropic" ||
      _h === "api.anthropic.com";
    if (_h === "models.github.ai") {
      push("https://models.github.ai/catalog/models");
    }
    if (
      _h === "generativelanguage.googleapis.com" &&
      !/\/openai(\/|$)/i.test(root)
    ) {
      push(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      );
    }
    if (_isAnthropicHost) {
      push(root.replace(/\/v\d+$/i, "") + "/v1/models?limit=1000");
    }
  } catch {}
  // 2. 根以 /vN 结尾 → root/models 优先; 否则 root/v1/models 优先
  if (/\/v\d+$/i.test(root)) {
    push(root + "/models");
    push(root + "/v1/models");
  } else {
    push(root + "/v1/models");
    push(root + "/models");
  }
  // 3. 协议+域名根兜底 (兼容子路径渠道探测失败时最后一搏)
  try {
    const u = new URL(root.includes("://") ? root : "https://" + root);
    if (u.origin && u.origin !== root) {
      push(u.origin + "/v1/models");
      push(u.origin + "/models");
    }
  } catch {}
  return out;
}
function _modelsUrlFor(cfg) {
  return _modelsUrlCandidates(cfg)[0];
}

// ★ 非对话模型名特征 (语音/向量/重排/图像/审核) · 自动发现时剔除
//   道义: 二十七章「善行无辙迹」· 自动回填只取可对话之模 · 不把 tts/asr/embedding 当对话模型路由 (必失败)
const _NON_CHAT_RE =
  /(^|[-_/.])(tts|asr|stt|whisper|voice|voiceclone|voicedesign|audio|speech|realtime|embed|embedding|embeddings|rerank|reranker|image|images|dall-?e|vision-ocr|ocr|moderation|guard|guardrail|t2v|i2v|t2i|i2i|t2a|seedance|seedream|seededit|seedance-?lite|video|sora|cogvideo|cogview|wanx|kolors|flux|midjourney|mj)([-_/.]|$)/i;
function _isChatModel(id) {
  if (!id || typeof id !== "string") return false;
  return !_NON_CHAT_RE.test(id);
}

// ★ 从 /models 的 supported_endpoint_types 自识协议 · 仅在 provider 未显式指定 protocol 时生效
//   道义: 道法自然 · 不着相于配置 · 从云端实证模型能力自识协议 (如 freemodel claude 系 → anthropic)
function _autoDetectProtocolFromModels(provCfg, dataArr) {
  if (!provCfg || provCfg.protocol) return; // 已显式指定 → 尊重用户
  let anyAnthropic = false;
  let anyOpenAI = false;
  for (const m of dataArr) {
    const types = Array.isArray(m && m.supported_endpoint_types)
      ? m.supported_endpoint_types.map((s) => String(s).toLowerCase())
      : [];
    if (types.includes("anthropic")) anyAnthropic = true;
    if (
      types.includes("openai") ||
      types.includes("chat") ||
      types.includes("openai-chat") ||
      types.includes("chat_completion") ||
      types.includes("chat.completions")
    )
      anyOpenAI = true;
  }
  if (anyAnthropic && !anyOpenAI) {
    provCfg.protocol = "anthropic";
    provCfg.type = "anthropic";
    const baseHasVer = /\/v\d+\/?$/i.test(String(provCfg.baseUrl || ""));
    provCfg.completionPath = baseHasVer ? "/messages" : "/v1/messages";
    _log(
      `[dao-router] [discover] ${provCfg.baseUrl || "?"} · 模型自识为 anthropic 协议 → completionPath=${provCfg.completionPath}`,
    );
  }
}

const _PROVIDER_PROTOCOLS = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
];
function _endpointProtocol(value) {
  const type = String(value || "")
    .toLowerCase()
    .replace(/[.\s]+/g, "-");
  if (
    type === "openai" ||
    type === "chat" ||
    type === "openai-chat" ||
    type === "chat-completion" ||
    type === "chat-completions" ||
    type === "chat_completion" ||
    type === "chat_completions"
  )
    return "openai-chat";
  if (
    type === "responses" ||
    type === "response" ||
    type === "openai-response" ||
    type === "openai-responses"
  )
    return "openai-responses";
  if (
    type === "anthropic" ||
    type === "message" ||
    type === "messages" ||
    type === "anthropic-messages"
  )
    return "anthropic";
  if (
    type === "gemini" ||
    type === "generate-content" ||
    type === "generatecontent"
  )
    return "gemini";
  return "";
}
function _providerProtocols(provCfg, models) {
  const found = [];
  const add = (value) => {
    const protocol = _endpointProtocol(value) || String(value || "");
    if (_PROVIDER_PROTOCOLS.includes(protocol) && !found.includes(protocol))
      found.push(protocol);
  };
  for (const protocol of provCfg.supportedProtocols || []) add(protocol);
  add(provCfg.protocol);
  add(provCfg.type);
  for (const model of models || []) {
    for (const endpoint of model.supported_endpoint_types || []) add(endpoint);
    for (const endpoint of model.supportedEndpointTypes || []) add(endpoint);
  }
  if (!found.length) {
    const completionPath = String(provCfg.completionPath || "").toLowerCase();
    const baseUrl = String(provCfg.baseUrl || "").toLowerCase();
    if (completionPath.includes("responses")) add("openai-responses");
    else if (completionPath.includes("messages")) add("anthropic");
    else if (
      completionPath.includes("generatecontent") ||
      baseUrl.includes("generativelanguage.googleapis.com")
    )
      add("gemini");
    else add("openai-chat");
  }
  return found;
}

// ★ 渠道级错误/拒绝模式 · 区别于「内容拒绝」(resilience.matchesRefusal 处理模型内容层)
//   这些是网关/渠道层的「伪成功」(HTTP 200 却是拒绝文案) 或鉴权失败文案
//   根因(实证): freemodel 返回 HTTP 200 + "Access Denied...official client only" →
//     仅看状态码必误判为通(绿点) · 须看响应体方知其不通
//   道义: 二十一章「名实相符」· 通则言通 · 不通则明言其不通
const _CHANNEL_ERR_PATTERNS = [
  /access denied/i,
  /restricted to authorized/i,
  /official[^.]{0,40}client only/i,
  /unauthorized (?:client|tooling|access|use)/i,
  /service unavailable/i,
  /invalid api key/i,
  /incorrect api key/i,
  /authentication[^.]{0,20}fail/i,
  /permission denied/i,
  /insufficient (?:quota|balance|credit|funds)/i,
  /quota[^.]{0,20}exceed/i,
  /account[^.]{0,30}suspend/i,
  /violation of the terms/i,
];

// ★ v9.9.308 · 渠道失败之「可读中文提因」· 名实相符 · 让用户一眼知该如何处置
//   实证(火山方舟): key 有效但账号未开通模型 → 404 ModelNotOpen → 原仅显笼统 "HTTP 404"
//   道义: 七十一章「知不知 尚矣」· 不止报不通 · 更明言因何不通、当往何处治
const _CHANNEL_HINTS = [
  {
    re: /ModelNotOpen|has not activated the model|model service is not (?:open|activated)|未开通|请开通|activate the model/i,
    hint: "模型未开通 · 请去服务商控制台开通(激活)该模型后重试(如火山方舟:开通管理)",
  },
  {
    re: /InvalidEndpointOrModel\.NotFound|does not exist or you do not have|model_not_found|no such model|model not found|unknown model|未找到模型|模型不存在/i,
    hint: "模型名/接入点不存在 · 请核对模型名(火山方舟需用模型名或接入点 ep-xxx)",
  },
  {
    re: /invalid api key|incorrect api key|authentication[^.]{0,20}fail|invalid[^.]{0,12}(?:token|credential)|api key not valid|unauthorized/i,
    hint: "Key 无效或鉴权失败 · 请核对 API Key(及是否选对协议/请求头)",
  },
  {
    re: /insufficient (?:quota|balance|credit|funds)|quota[^.]{0,20}exceed|balance|余额不足|额度不足|欠费/i,
    hint: "余额/配额不足 · 请充值或检查配额",
  },
  {
    re: /access denied|official[^.]{0,40}client only|restricted to authorized|unauthorized (?:client|tooling)/i,
    hint: "渠道拒绝(HTTP 200 伪成功) · 该中转仅限官方客户端/已授权访问",
  },
  {
    re: /rate limit|too many requests|requests per|限流|频率/i,
    hint: "触发限流 · 稍后重试或降低并发",
  },
  {
    re: /service (?:temporarily )?unavailable|temporarily unavailable|upstream|bad gateway|gateway time|暂不可用|服务不可用/i,
    hint: "中转/上游暂不可用(常为 503/502) · 多为该中转后端临时故障 · 稍后重试或换渠道",
  },
];
function _channelHint(text) {
  const raw = typeof text === "string" ? text : "";
  for (const h of _CHANNEL_HINTS) {
    if (h.re.test(raw)) return h.hint;
  }
  return "";
}

/**
 * 渠道响应分类 · 实证渠道是否真通 (不止看 HTTP 码 · 还看响应体伪成功/拒绝文案)
 *   返回 { ok, reason } · ok=false 时 reason 简述不通之因 (供前端展示给用户)
 *   道义: 七十一章「知不知 尚矣」· 知其不通方能明言其不通
 */
function classifyChannelResponse(status, text) {
  const raw = typeof text === "string" ? text : "";
  const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 160);
  const hint = _channelHint(raw);
  if (typeof status === "number" && status >= 400) {
    const base = `HTTP ${status}` + (snippet ? ` · ${snippet}` : "");
    return { ok: false, reason: hint ? `${hint} · ${base}` : base };
  }
  for (const p of _CHANNEL_ERR_PATTERNS) {
    if (p.test(raw)) {
      return {
        ok: false,
        reason: (hint ? hint + " · " : "") + `渠道拒绝/伪成功 · ${snippet}`,
      };
    }
  }
  return { ok: true, reason: "" };
}

/**
 * 实证探活 · 发一条最小真实 chat 请求 · 端到端验渠道是否真通
 *   不止探 /models (仅证 key 有效) · 更探真实推理是否被拒
 *   (如 freemodel: /models=200 却 chat 返回 Access Denied · github: /models=404 却 chat 通)
 *   道义: 四十八章「损之又损」· 损去表层探测之伪 · 直取真发之实
 */
function _verifyProviderChat(name, cfg, probeModel) {
  return new Promise((resolve) => {
    // ★ 探活用模型必须是渠道「真实模型」· 绝不退化用渠道名当模型
    //   旧法 `|| name`: 无 models 时把渠道名(如 deepseek)当模型发 → 上游 400
    //   「The supported API model names are ... but you passed <渠道名>」→ 误判探活失败。
    //   今: 无真实模型则明确返回「需先拉取模型」· 名实相符 (调用方 probeAllProviders 已先解模型)。
    const model =
      probeModel ||
      (Array.isArray(cfg.models) && cfg.models[0]) ||
      cfg.model ||
      cfg.defaultModel ||
      null;
    if (!model) {
      return resolve({
        alive: false,
        reason: "无可用模型 · 请先拉取模型(↻全部模型)",
        model: null,
      });
    }
    const proto =
      cfg.protocol ||
      (cfg.type === "anthropic" ? "anthropic" : "") ||
      (/\/v1\/messages/i.test(cfg.completionPath || "") ? "anthropic" : "") ||
      (String(model).toLowerCase().startsWith("claude") ? "anthropic" : "") ||
      "openai-chat";
    const isAnthropic = proto === "anthropic";
    const base = String(cfg.baseUrl || _gatewayUrl).replace(/\/$/, "");
    const cpath =
      cfg.completionPath ||
      (isAnthropic ? "/v1/messages" : "/v1/chat/completions");
    let u;
    try {
      u = new URL(_joinCompletionUrl(base, cpath));
    } catch (e) {
      return resolve({
        alive: false,
        reason: "baseUrl 非法: " + e.message,
        model,
      });
    }
    const mod = u.protocol === "https:" ? https : http;
    const payload = JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
    });
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
    };
    if (cfg.apiKey && !/\*{2,}/.test(cfg.apiKey)) {
      if (isAnthropic) {
        headers["x-api-key"] = cfg.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = "Bearer " + cfg.apiKey;
      }
    }
    // ★ 探活也要带 extraHeaders (如 anthropic-beta: context-1m) · 否则探活假阴
    if (cfg.extraHeaders && typeof cfg.extraHeaders === "object") {
      for (const [hk, hv] of Object.entries(cfg.extraHeaders)) {
        if (typeof hv === "string") headers[hk] = hv;
      }
    }
    const t0 = Date.now();
    const req = mod.request(
      {
        hostname: u.hostname,
        port: parseInt(u.port || (u.protocol === "https:" ? "443" : "80")),
        path: u.pathname + (u.search || ""),
        method: "POST",
        headers,
        timeout: 12000,
        rejectUnauthorized: _tlsRejectUnauthorized(),
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let content = "";
          try {
            const j = JSON.parse(data);
            const ch0 = j.choices && j.choices[0];
            if (ch0 && ch0.message)
              content =
                ch0.message.content || ch0.message.reasoning_content || "";
            else if (Array.isArray(j.content))
              content = j.content
                .filter((b) => b && b.type === "text")
                .map((b) => b.text)
                .join("");
            if (j.error)
              content =
                typeof j.error === "string"
                  ? j.error
                  : j.error.message || JSON.stringify(j.error);
          } catch {
            content = data;
          }
          const verdict = classifyChannelResponse(
            res.statusCode,
            content || data,
          );
          resolve({
            alive: verdict.ok,
            reason: verdict.reason,
            status: res.statusCode,
            model,
            elapsed_ms: Date.now() - t0,
            sample: (content || "").replace(/\s+/g, " ").trim().slice(0, 80),
          });
        });
      },
    );
    req.on("error", (e) =>
      resolve({ alive: false, reason: "连接错误 · " + e.message, model }),
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ alive: false, reason: "超时 (12s)", model });
    });
    req.end(payload);
  });
}

/** 主动探测所有provider健康 · 热重载后立即执行
 *  ★ 实证探活 (v9.9.285): 发一条最小真实 chat · 端到端验渠道真伪
 *    旧法只 GET /models + 看状态码 → 双向误判:
 *      freemodel /models=200 但 chat 被拒(Access Denied) → 误报 ALIVE(假阳)
 *      github   /models=404 但 chat 实通                → 误报 DEAD (假阴)
 *    新法直发 chat · 看状态码 + 响应体拒绝文案 → 名实相符
 */
async function probeAllProviders() {
  const results = {};
  for (const [name, cfg] of Object.entries(_providers)) {
    // 内置桩通道无需出网探测
    if (cfg._builtin || name === "builtin-stub") {
      results[name] = {
        alive: true,
        builtin: true,
        reason: "内置桩 · 固定返回",
      };
      _healthCache[name] = { alive: true, reason: "builtin", ts: Date.now() };
      continue;
    }
    if (cfg.enabled === false) {
      results[name] = { alive: false, reason: "已禁用 (enabled=false)" };
      _healthCache[name] = { alive: false, reason: "disabled", ts: Date.now() };
      continue;
    }
    // ★ 探活前先确保有「真实模型」可发 · 无则先拉取一次 (refresh)
    //   根因: 首次添加渠道时 models 尚空 → 直接探活会无模型可用 → 误判失败 · 须重启+手点。
    //   今: 探活统一入口先解模型再验 → 首次添加即可一步到位 (含启动自动探活·无需手点)。
    let probeCfg = cfg;
    if (!(Array.isArray(cfg.models) && cfg.models.length > 0)) {
      try {
        const pm = await hotListProviderModels(name, { refresh: true });
        if (pm && pm.ok && Array.isArray(pm.models) && pm.models.length > 0) {
          probeCfg = { ...(_providers[name] || cfg), models: pm.models };
        }
      } catch {}
    }
    const v = await _verifyProviderChat(name, probeCfg);
    results[name] = {
      alive: v.alive,
      reason: v.reason || (v.alive ? "通" : "不通"),
      status: v.status,
      model: v.model,
      elapsed_ms: v.elapsed_ms,
      sample: v.sample,
    };
    _healthCache[name] = {
      alive: v.alive,
      reason: v.reason,
      status: v.status,
      ts: Date.now(),
    };
    _log(
      `[dao-router] probe(chat) ${name}: ${v.alive ? "ALIVE" : "DEAD"}` +
        (v.reason ? ` · ${v.reason}` : "") +
        ` · model=${v.model}`,
    );
    // 探活成功 + 未配模型 → 顺手拉取一次模型列表回填 (best-effort)
    if (v.alive && !(Array.isArray(cfg.models) && cfg.models.length > 0)) {
      try {
        const m = await hotListProviderModels(name);
        if (m && m.ok && Array.isArray(m.models))
          results[name].models = m.models;
      } catch {}
    }
  }
  return results;
}

/** 最近一次探活快照 (非阻塞 · 供 overview 即时展示渠道连通+原因 · 不重新出网)
 *   道义: 四十七章「不出于户 以知天下」· 缓存即知 · 不扰真流
 */
function healthSnapshot() {
  const out = {};
  for (const [k, v] of Object.entries(_healthCache)) {
    if (/^_resolve_/.test(k)) continue;
    out[k] = {
      alive: !!v.alive,
      reason: v.reason || "",
      status: v.status,
      ts: v.ts,
    };
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// §3  热配置 API · 道法自然 · 无为而无不为
//   五十七章「我无为也 而民自化」· 热操作 · 不重启 · 即时生效
//   供 webview 前端 + Agent 后端 + /origin/ea/* 控制面使用
// ════════════════════════════════════════════════════════════════

/**
 * 热添加/更新 provider
 * @param {string} name - provider 名称
 * @param {object} cfg  - provider 配置 {type, baseUrl, apiKey, enabled, ...}
 * @returns {{ok: boolean, error?: string}}
 */
function hotAddProvider(name, cfg) {
  if (!name || typeof name !== "string")
    return { ok: false, error: "name required" };
  if (!cfg || typeof cfg !== "object")
    return { ok: false, error: "cfg required" };
  // ★ cc-switch 风 · baseUrl 归一: 剥去误含的补全后缀(/chat/completions 等) · 防双重路径 404
  //   实证: 小米渠道用户把完整端点贴进 baseUrl → 拼 completionPath 双重 → 完全不可用 · 此处根治
  if (cfg.baseUrl) {
    // ★ baseUrl 去内部空白 · 根治「http s://…」被切成 "http" 的渠道不可用 (URL 不含空格)
    cfg.baseUrl = String(cfg.baseUrl).trim().replace(/\s+/g, "");
    const _normBase = _stripCompletionSuffix(cfg.baseUrl);
    if (_normBase && _normBase !== String(cfg.baseUrl).replace(/\/+$/, "")) {
      _log(
        `[dao-router] [热] provider ${name}: baseUrl 归一 ${cfg.baseUrl} → ${_normBase} (剥补全后缀·防双重路径)`,
      );
      cfg.baseUrl = _normBase;
      // baseUrl 既已含补全路径 → completionPath 由下方按归一后 base 重新推断 (清旧值)
      if (!cfg.completionPath) delete cfg.completionPath;
    }
  }
  // ★ 自动检测 type: 根据 baseUrl 推断
  if (!cfg.type) {
    const url = (cfg.baseUrl || "").toLowerCase();
    if (url.includes("anthropic") || url.includes("claude"))
      cfg.type = "anthropic";
    else if (
      url.includes("generativelanguage.googleapis.com") ||
      url.includes("gemini")
    )
      cfg.type = "gemini";
    else if (url.includes("openai")) cfg.type = "openai-compatible";
    else if (url.includes("bedrock") || url.includes("amazonaws"))
      cfg.type = "bedrock";
    else cfg.type = "openai-compatible"; // 默认
  }
  // ★ 自动推断 completionPath · 防 baseUrl 已含 /vN 时重复拼 /v1 → /v1/v1/chat/completions 404
  //   道义: 二十二章「曲则全」· baseUrl 多形(含/不含版本段) · 归一方得真路 (与 _modelsUrlFor 同源)
  if (!cfg.completionPath) {
    const _baseHasVer = /\/v\d+\/?$/i.test(String(cfg.baseUrl || ""));
    if (cfg.protocol === "openai-responses")
      cfg.completionPath = _baseHasVer ? "/responses" : "/v1/responses";
    else if (cfg.protocol === "gemini" || cfg.type === "gemini")
      cfg.completionPath = "";
    else if (cfg.protocol === "anthropic" || cfg.type === "anthropic")
      cfg.completionPath = _baseHasVer ? "/messages" : "/v1/messages";
    else
      cfg.completionPath = _baseHasVer
        ? "/chat/completions"
        : "/v1/chat/completions";
  }
  // ★ 默认 streamMode
  if (!cfg.streamMode) cfg.streamMode = "stream";
  // ★ 默认启用
  if (cfg.enabled === undefined) cfg.enabled = true;

  // ★ v9.9.92-fix · 合并而非替换 · 防止脱敏 apiKey 覆盖真实 key
  //   道义: 三十九章「得一以宁」· 得 apiKey 之全方能宁
  //   根因: GET /providers 返回脱敏 apiKey(ghp_xxx***)
  //         POST /provider 传入脱敏 cfg → _providers[name]=cfg 覆盖真实 key
  //         → _callProvider 发脱敏 key → 401 Bad credentials
  //   修正: 合并现有 cfg → 跳过脱敏 apiKey → 保留真实 key
  const existing = _providers[name] || {};
  const merged = { ...existing, ...cfg };
  // ★ apiKey 保全 (修「编辑渠道→key 消失」根因之一)
  //   道义: 三十九章「得一以宁」· 得 apiKey 之全方能宁
  //   两类需保留原 key 的情形:
  //     (1) 传入脱敏 key (含***) — GET overview/providers 返回的是脱敏值
  //     (2) 传入空 key — 编辑既有渠道时用户未重输 key (前端清空了输入框)
  //   仅当用户真输入了一个非空、非脱敏的新 key 时才覆盖。
  const _incomingKey = cfg.apiKey == null ? "" : String(cfg.apiKey);
  const _keyMasked = /\*{2,}|\.{3}$/.test(_incomingKey);
  if ((!_incomingKey.trim() || _keyMasked) && existing.apiKey) {
    merged.apiKey = existing.apiKey;
    _log(
      `[dao-router] [热] provider ${name}: ${_keyMasked ? "脱敏" : "空"}apiKey → 保留原key (${existing.apiKey.length}B)`,
    );
  }
  // 单渠道单 key · 清理历史遗留的 apiKeys[]/endpoints[] · 重新保存即净化配置
  delete merged.apiKeys;
  delete merged.endpoints;
  _providers[name] = merged;
  _clearProviderRuntimeState(name);
  _log(
    `[dao-router] [热] 添加provider: ${name} type=${cfg.type} url=${cfg.baseUrl || "?"}`,
  );

  // ★ v9.9.262 · 首个 provider 自动默认路由 · 道法自然 · 无为而无不为
  //   用户首次添加第三方 provider 时 · 若 SWE 1.6 Fast 尚未路由 ·
  //   则自动把 MODEL_SWE_1_6_FAST 路由到该 provider 的第一个模型 (仅一个)。
  //   其余模型仍走官方 Cascade · 已存在路由则不覆盖 (尊重用户手动配置)。
  let autoRoute = null;
  const _hasSweFast =
    !!_routes["MODEL_SWE_1_6_FAST"] || !!_routes["swe-1-6-fast"];
  if (!_hasSweFast && merged.enabled !== false) {
    const m =
      merged.defaultModel ||
      (Array.isArray(merged.models) && merged.models.length
        ? merged.models[0]
        : null);
    if (m) {
      const rc = {
        provider: name,
        model: m,
        _label: `SWE 1.6 Fast → ${name}/${m} (默认)`,
        maxOutputTokens: 32768,
        _autoDefault: true,
      };
      _routes["MODEL_SWE_1_6_FAST"] = rc;
      _routes["swe-1-6-fast"] = rc;
      _syncReadyFromRoutes();
      autoRoute = `${name}/${m}`;
      _log(
        `[dao-router] [热] 首provider自动默认路由: MODEL_SWE_1_6_FAST → ${name}/${m}`,
      );
    }
  }

  // ★ 持久化到配置.json
  _hotSaveConfig();
  return { ok: true, autoRoute };
}

/**
 * 热删除 provider
 * @param {string} name - provider 名称
 * @returns {{ok: boolean, error?: string}}
 */
function hotRemoveProvider(name) {
  if (!_providers[name]) return { ok: false, error: "provider not found" };
  // 检查是否有路由引用此 provider
  const refs = Object.entries(_routes).filter(([, t]) => t.provider === name);
  if (refs.length > 0) {
    // 自动移除引用此 provider 的路由
    for (const [uid] of refs) {
      delete _routes[uid];
      _log(`[dao-router] [热] 自动移除路由: ${uid} (provider=${name} 被删)`);
    }
  }
  delete _providers[name];
  _clearProviderRuntimeState(name);
  _log(
    `[dao-router] [热] 删除provider: ${name} · 关联路由${refs.length}条已移除`,
  );
  _hotSaveConfig();
  _syncReadyFromRoutes();
  return { ok: true, removedRoutes: refs.length };
}

/**
 * 热添加/更新路由
 * @param {string} modelUid - 官方模型 UID (如 MODEL_SWE_1_6_FAST)
 * @param {object} routeCfg  - 路由配置 {provider, model, _label, maxOutputTokens, fallback, ...}
 * @returns {{ok: boolean, error?: string}}
 */
function hotAddRoute(modelUid, routeCfg) {
  if (!modelUid || typeof modelUid !== "string")
    return { ok: false, error: "modelUid required" };
  if (!routeCfg || typeof routeCfg !== "object")
    return { ok: false, error: "routeCfg required" };
  if (!routeCfg.provider)
    return { ok: false, error: "routeCfg.provider required" };
  if (!routeCfg.model) return { ok: false, error: "routeCfg.model required" };
  // 检查 provider 是否存在
  if (routeCfg.provider !== "builtin-stub" && !_providers[routeCfg.provider]) {
    return { ok: false, error: `provider "${routeCfg.provider}" not found` };
  }
  if (!routeCfg.maxOutputTokens) routeCfg.maxOutputTokens = 16384;
  _normalizeQualityRoute(modelUid, routeCfg);
  if (_modelCapabilities && routeCfg.reasoningLevel) {
    const providerCfg = _providers[routeCfg.provider] || {};
    const capability =
      (providerCfg.modelCapabilities &&
        providerCfg.modelCapabilities[routeCfg.model]) ||
      _modelCapabilities.infer(routeCfg.model, {}, providerCfg);
    routeCfg.capabilities = capability;
    Object.assign(
      routeCfg,
      _modelCapabilities.settingsFor(
        routeCfg.reasoningLevel,
        capability,
        routeCfg.sourceProtocol || routeCfg.protocol || providerCfg.protocol,
      ),
    );
  }

  _routes[modelUid] = routeCfg;
  _conversationProviderAffinity.clear();
  // ★ 同时注册规范化形式
  if (!modelUid.startsWith("_") && !modelUid.startsWith("MODEL_")) {
    const modelKey = "MODEL_" + modelUid.replace(/-/g, "_").toUpperCase();
    _routes[modelKey] = routeCfg;
  }
  if (modelUid.startsWith("MODEL_")) {
    const lowerKey = modelUid
      .replace(/^MODEL_/, "")
      .replace(/_/g, "-")
      .toLowerCase();
    _routes[lowerKey] = routeCfg;
  }

  _syncReadyFromRoutes(); // 有路由且未热关闭才就绪
  _log(
    `[dao-router] [热] 添加路由: ${modelUid} → ${routeCfg.provider}/${routeCfg.model}` +
      (routeCfg.fallback
        ? ` [备:${routeCfg.fallback.provider}/${routeCfg.fallback.model}]`
        : ""),
  );
  _hotSaveConfig();
  return { ok: true };
}

/**
 * 热删除路由
 * @param {string} modelUid - 官方模型 UID
 * @returns {{ok: boolean, error?: string}}
 */
function hotRemoveRoute(modelUid) {
  if (!_routes[modelUid]) return { ok: false, error: "route not found" };
  delete _routes[modelUid];
  // 同时清理规范化形式
  if (!modelUid.startsWith("_") && !modelUid.startsWith("MODEL_")) {
    const modelKey = "MODEL_" + modelUid.replace(/-/g, "_").toUpperCase();
    delete _routes[modelKey];
    _routeRuntime.delete(modelKey);
  }
  if (modelUid.startsWith("MODEL_")) {
    const lowerKey = modelUid
      .replace(/^MODEL_/, "")
      .replace(/_/g, "-")
      .toLowerCase();
    delete _routes[lowerKey];
    _routeRuntime.delete(lowerKey);
  }
  _routeRuntime.delete(modelUid);
  _syncReadyFromRoutes();
  _log(`[dao-router] [热] 删除路由: ${modelUid}`);
  _hotSaveConfig();
  return { ok: true };
}

/**
 * ★ 热切换思考强度 · 面板快捷开关调用
 *   道义: 三十七章「道恆無名 樸唯小」· 一键切换 · 不重建路由
 *   对 modelUid 和其 MODEL_ 大写形式同时生效
 * @param {string} modelUid
 * @param {string} level - "off"|"medium"|"high"|"low"|"auto"
 * @returns {{ok: boolean, error?: string, level?: string}}
 */
function hotSetReasoning(modelUid, level) {
  if (!modelUid) return { ok: false, error: "modelUid required" };
  const lvl = String(level || "off")
    .toLowerCase()
    .trim();
  const VALID = [
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "auto",
    "minimal",
  ];
  if (VALID.indexOf(lvl) < 0)
    return { ok: false, error: `invalid level "${level}"` };

  // 找到 route (兼容 MODEL_ 大写形式)
  const keys = [modelUid];
  if (!modelUid.startsWith("MODEL_")) {
    keys.push("MODEL_" + modelUid.replace(/-/g, "_").toUpperCase());
  }
  if (modelUid.startsWith("MODEL_")) {
    keys.push(
      modelUid
        .replace(/^MODEL_/, "")
        .replace(/_/g, "-")
        .toLowerCase(),
    );
  }

  let found = false;
  for (const k of keys) {
    const r = _routes[k];
    if (!r) continue;
    r.reasoningLevel = lvl;
    r.thinkingEnabled = lvl !== "off";
    r.thinkingBudget = lvl === "off" ? null : r.thinkingBudget;
    if (lvl !== "off") {
      r.reasoningEffort = lvl;
    } else {
      r.reasoningEffort = null;
    }
    // 更新 capabilities
    if (!r.capabilities) r.capabilities = {};
    r.capabilities.supportsThinking = lvl !== "off";
    r.capabilities.defaultReasoningLevel = lvl;
    if (
      !r.capabilities.reasoningLevels ||
      r.capabilities.reasoningLevels.indexOf(lvl) < 0
    ) {
      r.capabilities.reasoningLevels = ["off", "medium", "high"];
    }
    found = true;
  }

  if (!found) return { ok: false, error: "route not found: " + modelUid };

  _conversationProviderAffinity.clear();
  _log(`[dao-router] [热] 思考强度切换: ${modelUid} → ${lvl}`);
  _hotSaveConfig();
  return { ok: true, level: lvl };
}

/**
 * 获取完整配置 (供热配置API/Agent使用)
 * @returns {object}
 */
function hotGetConfig() {
  const visibleRoutes = Object.fromEntries(
    Object.entries(_routes).filter(
      ([, route]) => !(route && route._customModelRetired === true),
    ),
  );
  return {
    gateway: _cfg ? _cfg.gateway : { host: "127.0.0.1", port: 11435 },
    providers: { ..._providers },
    customModels: { ..._customModels },
    daoRoutes: {
      enabled: _cfg ? _cfg.daoRoutes && _cfg.daoRoutes.enabled : true,
      substituteEnabled: _substituteEnabled,
      allowMcpTools: _allowMcpTools,
      routes: visibleRoutes,
    },
    // ★ 运行时状态 · 与配置数据分离 · 名实相符
    _runtime: {
      ready: _ready,
      providerCount: Object.keys(_providers).length,
      routeCount: Object.keys(visibleRoutes).length,
      retiredCustomRouteCount:
        Object.keys(_routes).length - Object.keys(visibleRoutes).length,
      stats: { ..._stats },
    },
    // ★ v9.9.99 · Go 移植模块状态 · AI 热配置接口
    //   道义: 太上 下知有之 · 底层全开放 · AI可辅助用户配置一切
    _modules: {
      budget: _budget ? _budget.getBudgetStatus() : null,
      adapters: _adapters
        ? {
            protocols: _adapters.getSupportedProtocols(),
            modelInfoCache: _adapters.getModelInfoCache().size,
          }
        : null,
      resilience: _resilience ? _resilience.getDefaultConfig() : null,
    },
  };
}

function hotConfigFingerprint() {
  return _loadedConfigFingerprint;
}

/**
 * 批量设置配置 (供热配置API/Agent使用)
 * @param {object} newCfg - 完整或部分配置
 * @returns {{ok: boolean, error?: string}}
 */
function hotSetConfig(newCfg) {
  if (!newCfg || typeof newCfg !== "object")
    return { ok: false, error: "newCfg required" };
  try {
    if (newCfg.providers) {
      for (const [name, cfg] of Object.entries(newCfg.providers)) {
        if (name.startsWith("_")) continue;
        _providers[name] = cfg;
      }
    }
    if (newCfg.customModels) {
      for (const [id, record] of Object.entries(newCfg.customModels)) {
        if (!id.startsWith("_") && record && typeof record === "object")
          _customModels[id] = record;
      }
    }
    if (newCfg.daoRoutes) {
      const dr = newCfg.daoRoutes;
      if (dr.enabled !== undefined) {
        // ★ v9.9.90-fix · 更新全局 daoRoutes.enabled 到 _cfg
        if (_cfg && _cfg.daoRoutes)
          _cfg.daoRoutes.enabled = dr.enabled === true;
      }
      if (dr.substituteEnabled !== undefined)
        _substituteEnabled = dr.substituteEnabled === true;
      if (dr.allowMcpTools !== undefined)
        _allowMcpTools = dr.allowMcpTools !== false;
      if (dr.routes) {
        for (const [uid, t] of Object.entries(dr.routes)) {
          if (uid.startsWith("_") || typeof t !== "object" || !t.provider)
            continue;
          _routes[uid] = t;
        }
      }
    }
    _syncReadyFromRoutes();
    _log(
      `[dao-router] [热] 批量设置配置: providers=${Object.keys(_providers).length} routes=${Object.keys(_routes).length}`,
    );
    _hotSaveConfig();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 热重载: 从配置.json重新加载
 * @returns {{ok: boolean, count?: number, error?: string}}
 */
function hotReload() {
  try {
    const configPath = _cfg ? _cfg._configPath : null;
    if (!configPath) return { ok: false, error: "no configPath" };
    const result = init({ log: _log, configPath });
    return result.ready
      ? { ok: true, count: result.count }
      : { ok: false, error: result.error || result.reason };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 内部: 持久化当前配置到 配置.json
 *   道义: 二十五章「道法自然」· 变化即持久 · 持久即自然
 */
// ★ 全局选项(OTEL 导出 + Cascade 侧出站脱敏)读写 · 供 /origin/ea/* 面板热配置
function getGlobalOptions() {
  const otel = (_cfg && _cfg.otel) || {};
  const redact = (_cfg && _cfg.outboundRedact) || {};
  return {
    otel: {
      enabled: otel.enabled === true,
      endpoint: otel.endpoint || "",
      serviceName: otel.serviceName || "fomo-flow",
      stats: _otelExporter ? _otelExporter.snapshot() : null,
    },
    outboundRedact: {
      enabled: redact.enabled === true,
      mode: redact.mode || "redact",
    },
  };
}

function hotSetGlobalOptions(patch) {
  if (!patch || typeof patch !== "object")
    return { ok: false, error: "patch required" };
  try {
    if (!_cfg) return { ok: false, error: "config not loaded" };
    if (patch.otel && typeof patch.otel === "object") {
      const cur = _cfg.otel || {};
      const p = patch.otel;
      _cfg.otel = {
        ...cur,
        ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
        ...(typeof p.endpoint === "string" ? { endpoint: p.endpoint } : {}),
        ...(typeof p.serviceName === "string" && p.serviceName
          ? { serviceName: p.serviceName }
          : {}),
      };
      _initOtelExporter(); // 热生效: 重建导出器/订阅
    }
    if (patch.outboundRedact && typeof patch.outboundRedact === "object") {
      const cur = _cfg.outboundRedact || {};
      const p = patch.outboundRedact;
      _cfg.outboundRedact = {
        ...cur,
        ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
        ...(typeof p.mode === "string" &&
        ["monitor", "redact", "block"].includes(p.mode)
          ? { mode: p.mode }
          : {}),
      };
    }
    _hotSaveConfig();
    return { ok: true, options: getGlobalOptions() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function _hotSaveConfig() {
  try {
    if (!_cfg) return;
    const configPath = _cfg._configPath;
    if (!configPath) return;
    // 更新 _cfg 对象
    _cfg.providers = Object.fromEntries(
      Object.entries(_providers).map(([name, provider]) => [
        name,
        {
          ...provider,
          ...(provider._keychainApiKeyRef
            ? { apiKey: provider._keychainApiKeyRef }
            : {}),
        },
      ]),
    );
    _cfg.customModels = { ..._customModels };
    if (!_cfg.daoRoutes) _cfg.daoRoutes = {};
    _cfg.daoRoutes.routes = { ..._routes };
    _cfg.daoRoutes.substituteEnabled = _substituteEnabled;
    _cfg.daoRoutes.allowMcpTools = _allowMcpTools;
    // ★ 过滤内部字段 (以_开头) · 不污染配置.json · 名实相符
    const clean = {};
    for (const [k, v] of Object.entries(_cfg)) {
      if (!k.startsWith("_")) clean[k] = v;
    }
    const data = JSON.stringify(clean, null, 2);
    // ★ 记录自写内容 · 供 fs.watch 回调区分「自写」(跳过热重载) 与「外部手改」(重载)
    _lastSelfWriteData = data;
    // ★ v9.9.301 · 原子写 + 备份轮转 · 防写入中途被杀损坏配置.json
    //   道义: 六十四章「为之于未有 治之于未乱」· 临时文件+rename 原子落盘 · 旧本留痕
    if (_atomicSaveWithBackup(configPath, data)) {
      _loadedConfigFingerprint = crypto
        .createHash("sha256")
        .update(JSON.stringify(clean), "utf8")
        .digest("hex");
    }
  } catch (e) {
    _log(`[dao-router] _hotSaveConfig exception: ${e.message}`);
  }
}

const _BACKUP_KEEP = 10;
// 原子落盘: 先备份旧配置(轮转保留最近 N 份) · 再写临时文件 · 最后 rename 原子替换
function _atomicSaveWithBackup(configPath, data) {
  try {
    // 1. 备份现有配置 (存在且非空) → <dir>/.config-backups/<name>.<ts>.bak
    if (fs.existsSync(configPath)) {
      try {
        const bakDir = path.join(path.dirname(configPath), ".config-backups");
        if (!fs.existsSync(bakDir)) fs.mkdirSync(bakDir, { recursive: true });
        const base = path.basename(configPath);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(configPath, path.join(bakDir, `${base}.${stamp}.bak`));
        // 轮转: 仅保留最近 _BACKUP_KEEP 份
        const baks = fs
          .readdirSync(bakDir)
          .filter((f) => f.startsWith(base + ".") && f.endsWith(".bak"))
          .sort();
        while (baks.length > _BACKUP_KEEP) {
          const oldf = baks.shift();
          try {
            fs.unlinkSync(path.join(bakDir, oldf));
          } catch {}
        }
      } catch (be) {
        _log(`[dao-router] 配置备份失败(忽略): ${be.message}`);
      }
    }
    // 2. 原子写: 临时文件 → rename (同目录 · rename 原子)
    const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, configPath);
    _log(`[dao-router] _hotSaveConfig ok(原子): ${configPath} ${data.length}B`);
    return true;
  } catch (e) {
    _log(`[dao-router] _atomicSaveWithBackup exception: ${e.message}`);
    return false;
  }
}

/**
 * 获取 provider 可用模型列表 (从 provider 配置的 models 字段 + /v1/models 探测)
 * @param {string} providerName - provider 名称
 * @returns {Promise<{ok: boolean, models?: string[], error?: string}>}
 */
async function hotListProviderModels(providerName, opts) {
  const provCfg = _providers[providerName];
  if (!provCfg) return { ok: false, error: "provider not found" };
  const refresh = !!(opts && opts.refresh);

  // 1. 非强刷 且 已有配置 models → 直返 (快路径 · 供展示)
  if (!refresh && Array.isArray(provCfg.models) && provCfg.models.length > 0) {
    return {
      ok: true,
      models: provCfg.models,
      capabilities: provCfg.modelCapabilities || {},
      protocols: _providerProtocols(provCfg),
      source: "config",
    };
  }

  // 2. cc-switch 风多候选顺序探测 /models · 自动解全量模型 (不止配置子集)
  //   道义: 五十七章「我无为也 而民自化」· 用户只输 apiKey · 模型自现全量
  const candidates = _modelsUrlCandidates(provCfg);
  let lastErr = "";
  for (const cand of candidates) {
    let urlObj;
    try {
      urlObj = new URL(cand);
    } catch {
      continue;
    }
    const isHttps = urlObj.protocol === "https:";
    const mod = isHttps ? https : http;
    const headers = { Accept: "application/json" };
    // ★ 按协议/家族择认证头 · 不再一律 Bearer (Anthropic=x-api-key · Gemini原生=x-goog-api-key)
    //   道: 知其雄守其雌 · 各从其类 · 万邦皆通
    if (provCfg.apiKey) {
      const _bu = String(provCfg.baseUrl || "").toLowerCase();
      const _host = urlObj.hostname.toLowerCase();
      const _isAnthropic =
        provCfg.protocol === "anthropic" ||
        provCfg.type === "anthropic" ||
        /api\.anthropic\.com/.test(_bu) ||
        _host === "api.anthropic.com" ||
        /\/v1\/messages/.test(String(provCfg.completionPath || ""));
      if (
        _host === "generativelanguage.googleapis.com" &&
        !/\/openai(\/|$)/i.test(urlObj.pathname)
      ) {
        headers["x-goog-api-key"] = provCfg.apiKey;
      } else if (_isAnthropic) {
        headers["x-api-key"] = provCfg.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${provCfg.apiKey}`;
      }
    }
    // 自定义认证头 / 额外头 (与 adapters.applyAuthHeaders 同源)
    if (provCfg.authHeader) {
      const _ci = String(provCfg.authHeader).indexOf(":");
      if (_ci > 0)
        headers[provCfg.authHeader.slice(0, _ci).trim()] = provCfg.authHeader
          .slice(_ci + 1)
          .trim();
    }
    if (provCfg.extraHeaders && typeof provCfg.extraHeaders === "object") {
      Object.assign(headers, provCfg.extraHeaders);
    }
    const _agent = _getProxyAgent(isHttps);
    const out = await new Promise((resolve) => {
      const req = mod.request(
        {
          hostname: urlObj.hostname,
          port: parseInt(urlObj.port || (isHttps ? "443" : "80")),
          path: urlObj.pathname + (urlObj.search || ""),
          method: "GET",
          headers,
          timeout: 15000,
          rejectUnauthorized: _tlsRejectUnauthorized(),
          ...(_agent ? { agent: _agent } : {}),
        },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () =>
            resolve({ status: res.statusCode || 0, body: d }),
          );
          res.on("error", () => resolve({ status: 0, body: "" }));
        },
      );
      req.on("error", (e) => resolve({ status: 0, body: "err:" + e.message }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ status: 0, body: "timeout" });
      });
      req.end();
    });

    if (out.status >= 200 && out.status < 300 && out.body) {
      let parsed = null;
      try {
        parsed = JSON.parse(out.body);
      } catch {}
      // 兼容多形: {data:[...]} (OpenAI) / {models:[...]} / 顶层数组 / 元素为字符串
      let arr = null;
      if (parsed && Array.isArray(parsed.data)) arr = parsed.data;
      else if (parsed && Array.isArray(parsed.models)) arr = parsed.models;
      else if (Array.isArray(parsed)) arr = parsed;
      if (arr) {
        const all = arr
          .map((m) => (typeof m === "string" ? { id: m } : m))
          .filter((m) => m && (m.id || m.name));
        all.forEach((m) => {
          if (!m.id && m.name) m.id = m.name;
          // Gemini 原生 /v1beta/models 返回 name="models/gemini-..." · 去前缀
          if (typeof m.id === "string" && /^models\//.test(m.id))
            m.id = m.id.replace(/^models\//, "");
        });
        _autoDetectProtocolFromModels(provCfg, all);
        const protocols = _providerProtocols(provCfg, all);
        // 仅取「可对话」模型; 若过滤后为空则回退全部 · 不致空列表
        const chat = all.filter((m) => _isChatModel(m.id));
        const picked = chat.length > 0 ? chat : all;
        const models = Array.from(
          new Set(picked.map((m) => m.id).filter(Boolean)),
        ).sort();
        if (models.length > 0) {
          provCfg.models = models; // 缓存全量
          provCfg.supportedProtocols = protocols;
          if (_modelCapabilities) {
            const discoveredCapabilities = {};
            for (const item of picked) {
              if (item && item.id)
                discoveredCapabilities[item.id] = _modelCapabilities.infer(
                  item.id,
                  item,
                  provCfg,
                );
            }
            provCfg.modelCapabilities = Object.assign(
              {},
              provCfg.modelCapabilities || {},
              discoveredCapabilities,
            );
          }
          try {
            _hotSaveConfig();
          } catch {}
          return {
            ok: true,
            models,
            capabilities: provCfg.modelCapabilities || {},
            protocols,
            source: "probe",
            endpoint: cand,
            protocol: provCfg.protocol || undefined,
            filtered: all.length - models.length,
          };
        }
      }
      lastErr = `解析空 @ ${cand}`;
    } else if (out.status === 404 || out.status === 405 || out.status === 0) {
      // 此候选不通 → 试下一个
      lastErr = `HTTP ${out.status} @ ${cand}`;
      continue;
    } else {
      lastErr = `HTTP ${out.status} @ ${cand} ${String(out.body).slice(0, 120)}`;
      // 鉴权/额度等 → key 问题 · 不再试其他候选
      if (out.status === 401 || out.status === 403) break;
    }
  }

  // 3. 探测失败 → 回退配置 models (永不空列表)
  if (Array.isArray(provCfg.models) && provCfg.models.length > 0) {
    return {
      ok: true,
      models: provCfg.models,
      capabilities: provCfg.modelCapabilities || {},
      protocols: _providerProtocols(provCfg),
      source: "config-fallback",
      note: lastErr,
    };
  }
  return {
    ok: true,
    models: [],
    capabilities: provCfg.modelCapabilities || {},
    protocols: _providerProtocols(provCfg),
    source: "empty",
    note: lastErr,
  };
}

function hotListCustomModels() {
  return _customModelRegistry.list();
}

function hotGetModelCapability(provider, model) {
  return _customModelRegistry.getCapability(provider, model);
}

function hotUpsertCustomModel(input) {
  return _customModelRegistry.upsert(input);
}

function hotRemoveCustomModel(id) {
  return _customModelRegistry.remove(id);
}

function hotCustomModelCatalog() {
  return _customModelRegistry.catalog();
}

function hotDeleteRoute(modelUid) {
  return hotRemoveRoute(modelUid);
}

/**
 * ★ v9.9.97 · 解锁保护模型 · 用户显式允许路由
 * @param {string} modelUid
 * @param {boolean} unlock
 * @returns {{ok: boolean, unlocked: boolean, protected: boolean}}
 */
function unlockModel(modelUid, unlock) {
  if (!modelUid || typeof modelUid !== "string")
    return { ok: false, error: "modelUid required" };
  if (unlock) {
    _unlockedModels.add(modelUid);
    // 同时添加规范化形式
    const normalized = _normalizeModelUid(modelUid);
    if (normalized !== modelUid) _unlockedModels.add(normalized);
    _log(`[dao-router] [unlock] ${modelUid} → UNLOCKED`);
  } else {
    _unlockedModels.delete(modelUid);
    const normalized = _normalizeModelUid(modelUid);
    if (normalized !== modelUid) _unlockedModels.delete(normalized);
    _log(`[dao-router] [unlock] ${modelUid} → LOCKED`);
  }
  return {
    ok: true,
    unlocked: unlock,
    protected:
      _PROTECTED_MODELS.has(modelUid) && !_unlockedModels.has(modelUid),
  };
}

/**
 * ★ v9.9.97 · 检查模型是否被保护
 * @param {string} modelUid
 * @returns {boolean}
 */
function isModelProtected(modelUid) {
  if (!modelUid) return false;
  if (_unlockedModels.has(modelUid)) return false;
  // 1. 精确匹配
  if (_PROTECTED_MODELS.has(modelUid)) return true;
  // 2. ★ v9.9.97-fix · family级别匹配: glm-5-1, deepseek-v4, qwen3-coder 等新版本自动保护
  const lower = modelUid.toLowerCase();
  if (lower.startsWith("glm") || lower.startsWith("model_glm")) return true;
  if (lower.startsWith("deepseek") || lower.startsWith("model_deepseek"))
    return true;
  if (lower.startsWith("qwen") || lower.startsWith("model_qwen")) return true;
  return false;
}

// ════════════════════════════════════════════════════════════════
// ★ v9.9.99 · AI 热配置接口 · 移植自 Go EXE 核心模块
//   道义: 太上 下知有之 · 底层全开放 · AI可辅助用户配置一切
//   二十八章「知其白 守其辱 为天下式」· 开放一切底层 · 为天下式
// ════════════════════════════════════════════════════════════════

/**
 * ★ AI接口: 设置预算参数
 *   AI/Cascade Code 可辅助用户热配置 token 预算
 * @param {string} key - 预算参数名 (maxContextTokens, maxOutputTokens, etc.)
 * @param {*} value - 参数值
 * @returns {{ok: boolean, error?: string}}
 */
function hotSetBudgetParam(key, value) {
  if (!_budget) return { ok: false, error: "budget module not loaded" };
  return _budget.setBudgetConfig(key, value);
}

/**
 * ★ AI接口: 获取预算状态
 * @returns {object|null}
 */
function hotGetBudgetStatus() {
  if (!_budget) return null;
  return _budget.getBudgetStatus();
}

/**
 * ★ AI接口: 计算 token 数
 *   AI可辅助用户了解消息/工具的 token 消耗
 * @param {string} text - 要计算的文本
 * @param {string} [encoder] - 编码器名 (o200k_base, cl100k_base, p50k_base)
 * @returns {{tokens: number, encoder: string}}
 */
function hotCountTokens(text, encoder) {
  if (!_budget) return { tokens: -1, encoder: "unavailable" };
  return {
    tokens: _budget.countTokens(text, encoder || "o200k_base"),
    encoder: _budget.getBudgetStatus().encoder,
  };
}

/**
 * ★ AI接口: 检测协议类型
 *   AI可辅助用户配置 provider 的协议类型
 * @param {string} providerName - provider 名称
 * @returns {{protocol: string, supported: string[]}}
 */
function hotDetectProtocol(providerName) {
  if (!_adapters)
    return { protocol: "openai-chat", supported: ["openai-chat"] };
  const provCfg = _providers[providerName] || {};
  const model = (provCfg.models && provCfg.models[0]) || "";
  return {
    protocol: _adapters.detectProtocol(provCfg, model),
    supported: _adapters.getSupportedProtocols(),
  };
}

/**
 * ★ AI接口: 获取模型上下文长度
 * @param {string} model - 模型名称
 * @returns {{contextLength: number}}
 */
function hotGetModelContextLength(model) {
  if (!_adapters) return { contextLength: 128000 };
  return { contextLength: _adapters.pickContextLength(model) };
}

/**
 * ★ AI接口: 设置弹性配置
 * @param {string} key - 配置项名
 * @param {*} value - 配置值
 * @returns {{ok: boolean, error?: string}}
 */
function hotSetResilienceParam(key, value) {
  if (!_resilience) return { ok: false, error: "resilience module not loaded" };
  const cfg = _resilience.getDefaultConfig();
  if (!(key in cfg)) return { ok: false, error: `unknown key: ${key}` };
  // 注意: 弹性配置是运行时的 · 不持久化
  _log(`[dao-router] [热] resilience.${key} = ${JSON.stringify(value)}`);
  return { ok: true };
}

/**
 * ★ AI接口: 检测文本是否为拒绝响应
 * @param {string} text - 响应文本
 * @returns {{isRefusal: boolean}}
 */
function hotDetectRefusal(text) {
  if (!_resilience) return { isRefusal: false };
  return { isRefusal: _resilience.matchesRefusal(text) };
}

/**
 * ★ AI接口: 压缩 JSON Schema
 *   AI可辅助用户优化工具定义的 Schema
 * @param {object} schema - JSON Schema 对象
 * @param {boolean} [stripDoc] - 是否剥离文档字段
 * @returns {object}
 */
function hotCompactSchema(schema, stripDoc) {
  if (!_budget) return schema;
  return _budget.compactJSONSchema(schema, stripDoc !== false);
}

// ══ 可观测与配置历史 API · 供面板/插件调用 ══

/**
 * ★ 链路追踪: 最近 N 笔请求的完整轨迹 (路由→重试→换渠道→降级)
 * @param {number} [limit] - 条数 · 默认 50
 * @returns {Array<object>}
 */
function getRecentTraces(limit) {
  return _traceCenter ? _traceCenter.recent(limit) : [];
}

/**
 * ★ 告警中心: 增量拉取 (面板轮询弹通知) / 最近列表
 * @param {number} [sinceId] - 游标 · 只返回此 id 之后的告警
 * @returns {Array<object>}
 */
function getAlertsSince(sinceId, limit) {
  return _alertCenter ? _alertCenter.since(sinceId, limit) : [];
}
function getRecentAlerts(limit) {
  return _alertCenter ? _alertCenter.recent(limit) : [];
}
function subscribeAlerts(fn) {
  return _alertCenter ? _alertCenter.subscribe(fn) : () => {};
}

/**
 * ★ 配置历史: 列出 .config-backups 下的历史备份 (新→旧)
 * @returns {{ok: boolean, backups?: Array, error?: string}}
 */
function hotListConfigBackups() {
  const configPath = _cfg && _cfg._configPath;
  if (!configPath || !_configHistory)
    return { ok: false, error: "config_history 不可用" };
  return { ok: true, backups: _configHistory.listBackups(configPath) };
}

/**
 * ★ 一键回滚: 恢复到指定历史备份 (回滚前自动备份当前配置) · 回滚后热重载
 * @param {string} backupName - 备份文件名 (hotListConfigBackups 返回的 name)
 * @returns {{ok: boolean, error?: string}}
 */
function hotRollbackConfig(backupName) {
  const configPath = _cfg && _cfg._configPath;
  if (!configPath || !_configHistory)
    return { ok: false, error: "config_history 不可用" };
  const result = _configHistory.rollback(configPath, backupName);
  if (!result.ok) return result;
  const reloaded = hotReload();
  if (!reloaded.ok)
    return { ok: false, error: `回滚后重载失败: ${reloaded.error}` };
  _log(`[dao-router] [回滚] 配置已回滚到 ${backupName} · 已热重载`);
  return { ok: true };
}

/**
 * ★ 配置打包导出: 渠道+路由+自定义模型打包成一个 JSON 包 · 换电脑一键还原
 * @returns {{ok: boolean, pack?: object, error?: string}}
 */
function hotExportConfigPack() {
  const configPath = _cfg && _cfg._configPath;
  if (!configPath || !_configHistory)
    return { ok: false, error: "config_history 不可用" };
  return _configHistory.exportPack(configPath);
}

/**
 * ★ 配置包导入: 写入配置文件并热重载 (导入前原配置由备份轮转保留)
 * @param {object|string} pack - hotExportConfigPack 导出的包 (对象或 JSON 字符串)
 * @returns {{ok: boolean, error?: string}}
 */
function hotImportConfigPack(pack) {
  const configPath = _cfg && _cfg._configPath;
  if (!configPath || !_configHistory)
    return { ok: false, error: "config_history 不可用" };
  const result = _configHistory.importPack(configPath, pack);
  if (!result.ok) return result;
  const reloaded = hotReload();
  if (!reloaded.ok)
    return { ok: false, error: `导入后重载失败: ${reloaded.error}` };
  _log(`[dao-router] [导入] 配置包已导入 · 已热重载`);
  return { ok: true };
}

/**
 * ★ 失败模式统计: 渠道×错误类型聚合 + 建议
 * @returns {object} provider → {total, kinds, topKind, suggestion}
 */
function getFailureStats() {
  return _failureStats ? _failureStats.summary() : {};
}

/**
 * ★ 动作审计: 配置变更历史 (谁何时改了什么 · apiKey 已脱敏)
 */
function getAuditLog(limit) {
  return _actionAudit ? _actionAudit.recent(limit) : [];
}
function getAuditSince(sinceId, limit) {
  return _actionAudit ? _actionAudit.since(sinceId, limit) : [];
}

// ★ 安全网关: 危险热配置动作经此包装 · 每次调用入审计 (对外导出层包装 · 内部调用不双记)
function _audited(actionName, fn, argsSummarizer) {
  return function (...args) {
    const result = fn(...args);
    if (_actionAudit) {
      const recordResult = (r) =>
        _actionAudit.record({
          action: actionName,
          args: argsSummarizer ? argsSummarizer(...args) : args,
          result: r,
        });
      if (result && typeof result.then === "function") {
        result.then(recordResult, (e) =>
          recordResult({ ok: false, error: e.message }),
        );
      } else {
        recordResult(result);
      }
    }
    return result;
  };
}

module.exports = {
  init,
  isReady,
  extractModelUid,
  shouldRoute,
  resolveRoute,
  route,
  status,
  getSubstitution,
  patchModelUid,
  resetHealthCache,
  probeAllProviders,
  classifyChannelResponse,
  healthSnapshot,
  // ★ v9.9.301 · 用量聚合 (按渠道/模型) · 供「外接API」面板查看
  usage,
  // ★ v9.9.351 · 外部记账入口 (模型反代/test-chat 等非 Cascade 路径亦入同一张用量表)
  recordUsage: _recordUsage,
  agentStatusSummary: (key) =>
    _agentStatus ? _agentStatus.summary(key) : null,
  agentStatusList: () => (_agentStatus ? _agentStatus.listSummaries() : []),
  agentStatusSubscribe: (listener) =>
    _agentStatus ? _agentStatus.onDidUpdate(listener) : { dispose() {} },
  agentStatusSetMode: (key, mode) =>
    _agentStatus ? _agentStatus.setMode(key, mode, _cfg) : null,
  agentStatusOptions: () =>
    _agentStatus ? _agentStatus.options(_cfg) : { enabled: false },
  // ★ 热配置 API · 道法自然 · 危险动作经审计包装 (谁何时改了什么 · 可追溯)
  hotAddProvider: _audited("hotAddProvider", hotAddProvider, (name, cfg) => ({
    name,
    cfg,
  })),
  hotRemoveProvider: _audited(
    "hotRemoveProvider",
    hotRemoveProvider,
    (name) => ({ name }),
  ),
  hotAddRoute: _audited("hotAddRoute", hotAddRoute, (modelUid, routeCfg) => ({
    modelUid,
    routeCfg,
  })),
  hotRemoveRoute: _audited("hotRemoveRoute", hotRemoveRoute, (modelUid) => ({
    modelUid,
  })),
  // ★ OmniRoute 借鉴: 面板快捷思考开关
  hotSetReasoning: _audited(
    "hotSetReasoning",
    hotSetReasoning,
    (modelUid, level) => ({ modelUid, level }),
  ),
  hotDeleteRoute: _audited("hotDeleteRoute", hotDeleteRoute, (modelUid) => ({
    modelUid,
  })),
  hotGetConfig,
  hotConfigFingerprint,
  hotSetConfig: _audited("hotSetConfig", hotSetConfig, (newCfg) => ({
    providers: Object.keys((newCfg && newCfg.providers) || {}),
    routes: Object.keys(((newCfg && newCfg.daoRoutes) || {}).routes || {}),
  })),
  hotReload,
  hotListProviderModels,
  hotListCustomModels,
  hotGetModelCapability,
  hotUpsertCustomModel,
  hotRemoveCustomModel,
  hotCustomModelCatalog,
  // ★ v9.9.97 · 保护模型 API
  unlockModel: _audited("unlockModel", unlockModel, (modelUid, unlock) => ({
    modelUid,
    unlock,
  })),
  isModelProtected,
  // ★ v9.9.99 · AI 热配置接口 · Go 移植模块
  //   道义: 太上 下知有之 · 底层全开放 · AI可辅助用户配置一切
  hotSetBudgetParam,
  hotGetBudgetStatus,
  hotCountTokens,
  hotDetectProtocol,
  hotGetModelContextLength,
  hotSetResilienceParam,
  hotDetectRefusal,
  hotCompactSchema,
  // ★ 可观测三件套: 链路追踪 / 告警 / 配置历史与回滚与打包
  getRecentTraces,
  getAlertsSince,
  getRecentAlerts,
  subscribeAlerts,
  hotListConfigBackups,
  hotRollbackConfig: _audited(
    "hotRollbackConfig",
    hotRollbackConfig,
    (name) => ({ backup: name }),
  ),
  hotExportConfigPack,
  hotImportConfigPack: _audited(
    "hotImportConfigPack",
    hotImportConfigPack,
    () => ({}),
  ),
  // ★ 故障自愈与审计
  getFailureStats,
  getAuditLog,
  getAuditSince,
  // ★ OmniRoute 借鉴: 加权评分指标 (面板「渠道评分」可见)
  getChannelScores: () =>
    _channelScorer ? _channelScorer.metricsSummary() : {},
  // 路由建议只读快照：按请求时的指标重新套用指定视角，不改变实际 priority 调度。
  getRoutingDecisions,
  preflightRoute,
  getDecisionInbox,
  acknowledgeDecision,
  snoozeDecision,
  getRouteEvidence,
  otelStats: () => (_otelExporter ? _otelExporter.snapshot() : null),
  getGlobalOptions,
  hotSetGlobalOptions,
  _test: {
    buildOAMessages: _buildOAMessages,
    fixOAMessages: _fixOAMessages,
    applyRequestBudget: _applyRequestBudget,
    applyOutboundRedaction: _applyOutboundRedaction,
    conversationPromptCacheKey: _conversationPromptCacheKey,
    prepareAgentStatus: _prepareAgentStatus,
    agentStatusInjectOutbound: _agentStatusInjectOutbound,
    recordAgentRoute: _recordAgentRoute,
    finishAgentRequest: _finishAgentRequest,
    cacheFingerprint: _cacheFingerprint,
    resolvePromptCacheKey: _resolvePromptCacheKey,
    isPromptCacheKeyUnsupportedResponse: _isPromptCacheKeyUnsupportedResponse,
    isReasoningParamUnsupportedResponse: _isReasoningParamUnsupportedResponse,
    recordUsage: _recordUsage,
    cacheSamples: () => _cacheSamples.map((sample) => ({ ...sample })),
    getAffinityAgent: _getAffinityAgent,
    affinityAgentCount: () => _affinityAgents.size,
    upstreamFailurePolicy: _upstreamFailurePolicy,
    openUpstreamCircuit: _openUpstreamCircuit,
    getUpstreamCircuit: _getUpstreamCircuit,
    clearUpstreamCircuit: _clearUpstreamCircuit,
    autoFallbackTargets: _autoFallbackTargets,
    buildDispatchCandidates: _buildDispatchCandidates,
    planRoute: _planRoute,
    orderedConfiguredChannelTargets: _orderedConfiguredChannelTargets,
    rememberConversationProvider: _rememberConversationProvider,
    stickyConversationTarget: _stickyConversationTarget,
    requestReasoningSettings: _requestReasoningSettings,
    resolveTargetProtocol: _resolveTargetProtocol,
    resolveTargetProtocolDecision: _resolveTargetProtocolDecision,
    normalizeQualityRoute: _normalizeQualityRoute,
    usesProxyManagedExecution: _usesProxyManagedExecution,
    usesPersistedToolOutputs: _usesPersistedToolOutputs,
    missingRequiredToolArgs: _missingRequiredToolArgs,
    isLocalWorkspaceTool: _isLocalWorkspaceTool,
    shouldInterceptLocalWorkspaceTool: _shouldInterceptLocalWorkspaceTool,
    hasOfficialEmptyWorkspaceMetadata: _hasOfficialEmptyWorkspaceMetadata,
    requestWorkspaceRoots: _requestWorkspaceRoots,
    localWorkspaceFallbackMode: _localWorkspaceFallbackMode,
    normalizeWorkspaceToolCall: _normalizeWorkspaceToolCall,
    executeServerTool: _executeServerTool,
    filterRetryTools: _filterRetryTools,
    contextStrategyStatus: () =>
      _contextStrategy
        ? _contextStrategy.status()
        : { sessions: 0, checkpoints: 0 },
    promptCachePolicyStatus: () =>
      _promptCachePolicy
        ? _promptCachePolicy.status()
        : { unsupportedProviders: [], activeWarmups: 0 },
    workspaceToolStrategyStatus: () =>
      _workspaceToolStrategy
        ? _workspaceToolStrategy.status()
        : { sessions: 0, degradedSessions: 0, last: null },
    upstreamCircuits: () =>
      Array.from(_upstreamCircuits.values()).map((circuit) => ({ ...circuit })),
    conversationAffinityCount: () => _conversationProviderAffinity.size,
    clearRoutingDecisions: _clearRoutingDecisions,
    recordRoutingDecision: _recordRoutingDecision,
    isHardFailure: _isHardFailure,
    sameProviderMaxRetries: _sameProviderMaxRetries,
    sameProviderMaxRetriesDefault: _sameProviderMaxRetriesDefault,
  },
};

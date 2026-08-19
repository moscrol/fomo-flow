#!/usr/bin/env node
/**
 * revproxy.js · 模型反代 (Model Reverse Proxy) · 反者道之动
 * ──────────────────────────────────────────────────────────────────────
 * 唯一职: 把「渠道配置 / 模型路由」里已接通的模型(免费 GLM / 官方家族映射 / 任意
 *         OpenAI·Anthropic 兼容渠道)反向暴露为**标准本地端点**, 脱离 Devin Desktop,
 *         供智能家居 / 本地脚本 / 其他设备直接以标准 SDK 调用。
 *
 *   入站(本地客户端)            内部                          出站(渠道配置之真上游)
 *   ─────────────────          ─────────────                 ──────────────────────
 *   POST /v1/chat/completions  → 归一 {messages,system,...} → openai-chat  /v1/chat/completions
 *   POST /v1/messages (Claude) → 经 模型路由 解析目标渠道   → anthropic    /v1/messages
 *   GET  /v1/models            → 列出可反代模型(routed)
 *
 *   道义: 四十章「反者道之动」· 官方反代是「入站→剥提示归本源→标准出站」的反向通道;
 *         与正向 source.js(Cascade→上游)同源同法, 仅方向相反。
 *
 * 鉴权: 本地客户端持 Bearer <apiKey> (或 x-api-key)。apiKey 空 → 仅 127.0.0.1 放行。
 * 配置: ~/.codeium/dao-byok/revproxy.json
 *   { enabled, apiKey, applyInvert, exposeLan, defaultMaxTokens }
 *
 * 本模块自包含(只依赖 node 内置 + 同目录 adapters.js), 由 source.js 在 /v1/* 与
 * /origin/revproxy/* 路径上委派调用。
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveStateDir } = require("../../../core/product_identity.js");
const crypto = require("crypto");

let _adapters = null;
function _getAdapters() {
  if (_adapters) return _adapters;
  try {
    _adapters = require(path.join(__dirname, "adapters.js"));
  } catch (e) {
    _adapters = null;
  }
  return _adapters;
}

// ★ OmniRoute 借鉴: SSE 早期心跳 + adaptive thinking 出站守卫
let _sseKeepalive = null;
function _getSseKeepalive() {
  if (_sseKeepalive) return _sseKeepalive;
  try {
    _sseKeepalive = require(path.join(__dirname, "sse_keepalive.js"));
  } catch (_) {
    _sseKeepalive = null;
  }
  return _sseKeepalive;
}
let _thinkingGuard = null;
let _configuredConfigPath = null;
const _configuredConfigPathGlobal = "__daoRevproxyConfiguredConfigPath";
function _getThinkingGuard() {
  if (_thinkingGuard) return _thinkingGuard;
  try {
    _thinkingGuard = require(path.join(__dirname, "adaptive_thinking_guard.js"));
  } catch (_) {
    _thinkingGuard = null;
  }
  return _thinkingGuard;
}
let _outboundRedact = null;
function _getOutboundRedact() {
  if (_outboundRedact) return _outboundRedact;
  try {
    _outboundRedact = require(path.join(__dirname, "outbound_redact.js"));
  } catch (_) {
    _outboundRedact = null;
  }
  return _outboundRedact;
}
let _exactCache = null;
let _exactCacheFactory = null;
function _getExactCache(cfg) {
  const ec = (cfg && cfg.exactCache) || {};
  if (!_exactCacheFactory) {
    try {
      _exactCacheFactory = require(path.join(__dirname, "exact_cache.js"));
    } catch (_) {
      _exactCacheFactory = null;
      return null;
    }
  }
  if (!_exactCache) {
    _exactCache = _exactCacheFactory.createExactCache({
      maxEntries: ec.maxEntries,
      ttlMs: ec.ttlMs,
    });
  } else {
    _exactCache.setOptions({ maxEntries: ec.maxEntries, ttlMs: ec.ttlMs });
  }
  return _exactCache;
}

let _semanticCache = null;
let _semanticCacheFactory = null;
function _getSemanticCache(cfg) {
  const sc = (cfg && cfg.semanticCache) || {};
  if (!_semanticCacheFactory) {
    try {
      _semanticCacheFactory = require(path.join(__dirname, "semantic_cache.js"));
    } catch (_) {
      _semanticCacheFactory = null;
      return null;
    }
  }
  if (!_semanticCache) {
    _semanticCache = _semanticCacheFactory.createSemanticCache({
      maxEntries: sc.maxEntries,
      ttlMs: sc.ttlMs,
      threshold: sc.threshold,
    });
  } else {
    _semanticCache.setOptions({
      maxEntries: sc.maxEntries,
      ttlMs: sc.ttlMs,
      threshold: sc.threshold,
    });
  }
  return _semanticCache;
}

function _semanticNs(clientKind, target, norm) {
  return [
    clientKind || "",
    target && target.official ? "official" : (target && target.provName) || "",
    (target && target.upstreamModel) || (norm && norm.model) || "",
  ].join("|");
}

// 语义缓存的查询文本: 优先保留 system (避免尾截断丢掉指令), 其余取消息尾部。
function _semanticEmbedText(norm, maxChars) {
  const cap = Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 8000;
  const system = norm.system ? String(norm.system) : "";
  const parts = [];
  for (const m of norm.messages || []) {
    if (!m) continue;
    const c = m.content;
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (part && typeof part.text === "string") parts.push(part.text);
      }
    }
  }
  const rest = parts.join("\n");
  if (!system) return rest.length > cap ? rest.slice(-cap) : rest;
  const joined = system + "\n" + rest;
  if (joined.length <= cap) return joined;
  const sysBudget = Math.min(system.length, Math.max(16, Math.floor(cap * 0.4)));
  const restBudget = Math.max(0, cap - sysBudget - 1);
  return (
    system.slice(0, sysBudget) +
    "\n" +
    (rest.length > restBudget ? rest.slice(-restBudget) : rest)
  );
}

// 调用 OpenAI 兼容 embeddings 端点 → 返回向量 (失败返回 null · 语义缓存降级为直连)。
let _embedFailUntil = 0;
let _embedFails = 0;
function _embedText(text, embedCfg, deps) {
  return new Promise((resolve) => {
    try {
      if (Date.now() < _embedFailUntil) {
        resolve(null);
        return;
      }
      if (!embedCfg || !embedCfg.baseUrl || !embedCfg.model || !text) {
        resolve(null);
        return;
      }
      const base = String(embedCfg.baseUrl).replace(/\/$/, "");
      const urlStr = base.endsWith("/embeddings") ? base : base + "/embeddings";
      const url = new URL(urlStr);
      const mod = url.protocol === "https:" ? https : http;
      const payload = JSON.stringify({ model: embedCfg.model, input: text });
      const headers = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      };
      if (embedCfg.apiKey) headers.Authorization = "Bearer " + embedCfg.apiKey;
      const agent = deps && deps.getProxyAgent ? deps.getProxyAgent(url.href) : undefined;
      let settled = false;
      const done = (vec) => {
        if (settled) return;
        settled = true;
        if (vec) {
          _embedFails = 0;
        } else {
          _embedFails++;
          if (_embedFails >= 2) _embedFailUntil = Date.now() + 15000;
        }
        resolve(vec);
      };
      const req = mod.request(
        url,
        { method: "POST", headers, agent, timeout: embedCfg.timeoutMs || 2000 },
        (resp) => {
          const chunks = [];
          resp.on("data", (d) => chunks.push(d));
          resp.on("end", () => {
            try {
              const obj = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const vec =
                obj && obj.data && obj.data[0] && Array.isArray(obj.data[0].embedding)
                  ? obj.data[0].embedding
                  : null;
              done(vec);
            } catch (_) {
              done(null);
            }
          });
        },
      );
      req.on("error", () => done(null));
      req.on("timeout", () => {
        try { req.destroy(); } catch (_) {}
        done(null);
      });
      req.end(payload);
    } catch (_) {
      resolve(null);
    }
  });
}

// 缓存响应头时剔除易变/连接相关头 (回放时由 writeHead 重新计算)
function _cacheableHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const deny = new Set(["date", "connection", "keep-alive", "retry-after", "x-dao-cache"]);
  const out = {};
  for (const k of Object.keys(headers)) {
    if (!deny.has(k.toLowerCase())) out[k] = headers[k];
  }
  return out;
}

// 捕获非流式响应用于缓存: 拦 res.writeHead/res.end · 原样透传给客户端,
//   同时把最终 status/headers/body 交给 onComplete (只在 200 时由调用方入缓存)。
function _teeUnaryResponse(res, onComplete) {
  const origWriteHead = res.writeHead.bind(res);
  const origEnd = res.end.bind(res);
  let status = 200;
  let headers = null;
  const chunks = [];
  res.writeHead = function (code, hdrs) {
    status = code;
    if (hdrs) headers = hdrs;
    return origWriteHead(code, hdrs);
  };
  res.end = function (chunk, ...rest) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    try {
      onComplete(status, headers, Buffer.concat(chunks));
    } catch (_) {}
    return origEnd(chunk, ...rest);
  };
}

function _byokDir() {
  const configuredPath = getConfiguredConfigPath();
  if (configuredPath) return path.dirname(configuredPath);
  return resolveStateDir();
}
function _cfgPath() {
  const configuredPath = getConfiguredConfigPath();
  if (configuredPath) return configuredPath;
  const d = _byokDir();
  return d ? path.join(d, "revproxy.json") : null;
}

/**
 * Explicit host configuration avoids a process-wide environment override.
 * Calling without a path restores the historical VSIX lookup behavior.
 */
function configure(opts = {}) {
  if (opts.configPath === undefined || opts.configPath === null || opts.configPath === "") {
    _configuredConfigPath = null;
    try { delete globalThis[_configuredConfigPathGlobal]; } catch (_) {}
    return _configuredConfigPath;
  }
  _configuredConfigPath = path.resolve(String(opts.configPath));
  try { globalThis[_configuredConfigPathGlobal] = _configuredConfigPath; } catch (_) {}
  return _configuredConfigPath;
}

function getConfiguredConfigPath() {
  return _configuredConfigPath || globalThis[_configuredConfigPathGlobal] || null;
}

function defaultConfig() {
  return {
    enabled: false,
    // 本地客户端鉴权 key · 空串=仅 localhost 放行 · 生成一次落盘
    apiKey: "",
    // 是否对入站 system 施「本源观照」(invertSP·剥官方着相归本源) · 默认否(透传用户提示)
    applyInvert: false,
    // 是否允许局域网(0.0.0.0)其他设备访问 · 仅状态标记, 实际监听仍由 source.js 决定
    exposeLan: false,
    defaultMaxTokens: 4096,
    // 提示词隔离(回归模型本源): 官方直通复用捕获帧时, 剥净 Cascade/DAO 系统提示词,
    //   使反代出去的即上游模型最本源 API 形态("Kimi 即 Kimi"·不冒认 Cascade)。
    //   默认开·符合「反代=回归本源」之义; 关则透传捕获帧原 SP(旧行为)。
    isolatePrompt: true,
    // 模型外接选择(用户可择): 被排除(不对外反代)之模型 uid 列表。空=全部反代(默认)。
    //   道: 万物并育, 默认全通; 用户按需「去彼」某些模型不外接。
    disabledModels: [],
    // 反代档位热切换: familyUid → 当前活跃档 modelUid (空=按默认规则·免费档优先)
    tiers: {},
    // 双路互补(道并行而不相悖): 主路(官方直通/渠道)遇限流·配额且未出首字节时,
    //   自动切「另一路」(同族已配渠道 ↔ 同族官方直通)。默认开·根治「卡限流」。
    dualPath: true,
    // 出站脱敏(治于未乱): 发往上游前扫高置信度密钥/凭证。默认关。
    //   { enabled, mode:"monitor"|"redact"|"block", enableRules, disableRules, customRules }
    outboundRedact: { enabled: false, mode: "redact" },
    // exact-match 缓存(三层缓存之第一层): 请求 byte 级相同则回放。默认关。
    //   仅非流式且无工具的成功响应入缓存。{ enabled, ttlMs, maxEntries }
    exactCache: { enabled: false, ttlMs: 300000, maxEntries: 500 },
    // 语义缓存(三层缓存之第二层): embedding 余弦≥阈值则回放。默认关(有假阳性风险)。
    //   需配 embed 端点。{ enabled, threshold, ttlMs, maxEntries, embed:{baseUrl,model,apiKey} }
    semanticCache: {
      enabled: false,
      threshold: 0.95,
      ttlMs: 300000,
      maxEntries: 200,
      embed: { baseUrl: "", model: "", apiKey: "" },
    },
  };
}

// ── 配置内存缓存 (每 /v1/* 请求都调 loadConfig · 用 mtime+size 免去重复
//    readFile+JSON.parse; stat 远比 parse 便宜) ──────────────────────────
let _cfgCache = { path: null, mtimeMs: -1, size: -1, cfg: null };

function loadConfig() {
  const p = _cfgPath();
  // 缓存命中: 同路径且 mtime+size 未变 → 直接返回 (读者只读, 写者各自 shallow-copy 后再改)
  if (p && _cfgCache.cfg && _cfgCache.path === p) {
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs === _cfgCache.mtimeMs && st.size === _cfgCache.size) {
        return _cfgCache.cfg;
      }
    } catch (_) {
      // stat 失败(文件被删) → 落到重建路径
    }
  }
  let cfg = defaultConfig();
  let existed = false;
  try {
    if (p && fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      cfg = Object.assign(cfg, raw || {});
      existed = true;
    }
  } catch (_) {}
  cfg = _coerceRevproxyConfig(cfg);
  // 首次无 key → 生成稳定本地 key 落盘 (dao-local-xxxx)
  if (!cfg.apiKey) {
    cfg.apiKey = "dao-local-" + crypto.randomBytes(12).toString("hex");
    saveConfig(cfg); // saveConfig 内部会刷新缓存
    return cfg;
  }
  if (p && existed) _refreshCfgCache(p, cfg);
  return cfg;
}

function _refreshCfgCache(p, cfg) {
  try {
    const st = fs.statSync(p);
    _cfgCache = { path: p, mtimeMs: st.mtimeMs, size: st.size, cfg };
  } catch (_) {
    _cfgCache = { path: null, mtimeMs: -1, size: -1, cfg: null };
  }
}

function _coerceRevproxyConfig(cfg) {
  const d = defaultConfig();
  if (!cfg || typeof cfg !== "object") return d;
  if (typeof cfg.apiKey !== "string") {
    cfg.apiKey =
      cfg.apiKey == null || cfg.apiKey === "" ? "" : String(cfg.apiKey);
  }
  for (const key of ["outboundRedact", "exactCache", "semanticCache"]) {
    if (!cfg[key] || typeof cfg[key] !== "object" || Array.isArray(cfg[key])) {
      cfg[key] = { ...d[key] };
    } else {
      cfg[key] = Object.assign({}, d[key], cfg[key]);
    }
  }
  if (
    !cfg.semanticCache.embed ||
    typeof cfg.semanticCache.embed !== "object" ||
    Array.isArray(cfg.semanticCache.embed)
  ) {
    cfg.semanticCache.embed = { ...d.semanticCache.embed };
  } else {
    cfg.semanticCache.embed = Object.assign(
      {},
      d.semanticCache.embed,
      cfg.semanticCache.embed,
    );
  }
  return cfg;
}

function saveConfig(cfg) {
  const d = _byokDir();
  const p = _cfgPath();
  if (!d || !p) return false;
  try {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
    fs.renameSync(tmp, p);
    _refreshCfgCache(p, cfg); // 写后即刷新缓存 · 下次读命中新值
    return true;
  } catch (_) {
    return false;
  }
}

// ── 鉴权 ────────────────────────────────────────────────────────────────
// cloudflared/反代隧道在本机把公网流量转发到 127.0.0.1, 若仅凭 socket 地址判本机,
// 公网请求会被误判为本机而绕过鉴权 —— 内网穿透之下这是致命的越权口子。
// 故: 一旦携带 Cloudflare 边缘/转发头(cf-*, x-forwarded-*, forwarded, via),
// 即视为来自公网, 不再享「本机免 key」待遇。
function _isForwarded(req) {
  const h = req.headers || {};
  return !!(
    h["cf-connecting-ip"] ||
    h["cf-ray"] ||
    h["cf-ipcountry"] ||
    h["cf-visitor"] ||
    h["x-forwarded-for"] ||
    h["x-forwarded-host"] ||
    h["forwarded"] ||
    h["via"]
  );
}
function _isLocal(req) {
  if (_isForwarded(req)) return false;
  const a = (req.socket && req.socket.remoteAddress) || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
function _authOk(req, cfg) {
  if (!cfg.apiKey) return _isLocal(req); // 无 key → 仅本机
  const h = req.headers || {};
  const bearer = (h["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  const xkey = (h["x-api-key"] || "").trim();
  const googleKey = (h["x-goog-api-key"] || "").trim();
  const given = bearer || xkey || googleKey;
  if (!given) return false;
  // 定长比较 · 防时序侧信道
  try {
    const a = Buffer.from(given);
    const b = Buffer.from(cfg.apiKey);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {
    return given === cfg.apiKey;
  }
}

// ── 模型枚举 ──────────────────────────────────────────────────────────────
// 全量呈现「一切可反代之模型」(道:万物并育而不相害):
//   ① 模型路由表每条 route(第三方渠道/builtin-stub)·② 渠道显式 models ·
//   ③ 官方全量模型目录(_full_model_catalog 108)·④ 运行时官方家族(账号当前可见)。
//   每个模型按「配额/费档」着色: 免费/有渠道=绿 · 配额耗尽=红 · 未探测=琥珀。
//   反代方式: channel(经第三方渠道) / official(官方直通) / stub(传输自验)。

// 官方 provider 枚举 → 人类可读
const _PROVIDER_LABEL = {
  MODEL_PROVIDER_ANTHROPIC: "Anthropic",
  MODEL_PROVIDER_OPENAI: "OpenAI",
  MODEL_PROVIDER_GOOGLE: "Google",
  MODEL_PROVIDER_XAI: "xAI",
  MODEL_PROVIDER_DEEPSEEK: "DeepSeek",
  MODEL_PROVIDER_FIREWORKS: "Fireworks",
  MODEL_PROVIDER_CODEIUM: "Windsurf",
  MODEL_PROVIDER_WINDSURF: "Windsurf",
  MODEL_PROVIDER_ZHIPU: "Zhipu/GLM",
};
function _provLabel(raw) {
  if (!raw) return "Official";
  if (_PROVIDER_LABEL[raw]) return _PROVIDER_LABEL[raw];
  return String(raw).replace(/^MODEL_PROVIDER_/, "");
}

// 官方免费档判定: costTier=FREE 或 creditMultiplier=0
function _isFreeTier(costTier, mult) {
  return (
    costTier === "MODEL_COST_TIER_FREE" ||
    mult === 0 ||
    mult === null ||
    mult === undefined
  );
}

// ── 家族·档位归一 (反代档位热切换 · 朴散则为器·大制无割) ─────────────────────
//   119 档本是「家族 + 档位」: 同族多档(none/low/medium/high/xhigh/max,+thinking/+fast)
//   各为独立 modelUid。此处按家族归组,保留各档 uid,供前端档位热切换 + 外部以
//   干净家族名(如 glm-5.1)调用「当前活跃档」。与 Devin Desktop 选档同一底层逻辑。
function _slug(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.\-]/g, "");
}
// 整 label 去家族前缀 → 余下即档位名(Medium / Low Thinking / High Fast …)
function _tierFromLabel(label, famLabel) {
  let t = String(label || "");
  if (famLabel && t.indexOf(famLabel) === 0) t = t.slice(famLabel.length).trim();
  return t || "base";
}
// 档位强弱排序(供默认择档·中档兜底): none<minimal<low<medium<high<xhigh<max
const _TIER_RANK = {
  none: 0,
  "no thinking": 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  "x-high": 5,
  max: 6,
};
function _tierRank(tier) {
  const t = String(tier || "").toLowerCase();
  for (const k of Object.keys(_TIER_RANK))
    if (t.indexOf(k) >= 0) return _TIER_RANK[k];
  return 3;
}
// 从官方目录构建家族索引: {byUid: uid→meta, families: familyUid→{members:[uid]}}
function buildFamilyIndex(deps) {
  const byUid = new Map();
  const families = new Map();
  let cat = [];
  try {
    cat = (deps && deps.getModelCatalog && deps.getModelCatalog()) || [];
  } catch (_) {}
  for (const m of cat) {
    if (!m || !m.modelUid) continue;
    const mi = m.modelInfo || {};
    const fmeta = m.modelFamilyMetadata || {};
    const famUid =
      mi.modelFamilyUid || fmeta.modelFamilyLabel || "__solo__" + m.modelUid;
    const famLabel = fmeta.modelFamilyLabel || m.label || m.modelUid;
    const tier = _tierFromLabel(m.label, famLabel);
    byUid.set(m.modelUid, {
      familyUid: famUid,
      familyLabel: famLabel,
      tier,
      tierRank: _tierRank(tier),
      isDefault: !!m.isDefaultModelInFamily,
      free: _isFreeTier(m.modelCostTier || m.costTier, m.creditMultiplier),
    });
    if (!families.has(famUid))
      families.set(famUid, {
        familyUid: famUid,
        familyLabel: famLabel,
        aliasSlug: _slug(famLabel),
        provider: _provLabel(m.provider),
        members: [],
      });
    families.get(famUid).members.push(m.modelUid);
  }
  return { byUid, families };
}
// 一族的「当前活跃档」: 已选(cfg.tiers)优先, 否则 免费档→家族默认档→中档→首档
//   ("免费即默认主力" 通用规则·GLM 等免费档自动成默认)
function _familyActiveUid(fam, idx, cfg) {
  const tiers = (cfg && cfg.tiers) || {};
  const set = tiers[fam.familyUid];
  if (set && fam.members.indexOf(set) >= 0) return set;
  let freeM = null,
    defM = null,
    midM = null;
  for (const uid of fam.members) {
    const info = idx.byUid.get(uid) || {};
    if (info.free && !freeM) freeM = uid;
    if (info.isDefault && !defM) defM = uid;
    if (info.tierRank === 3 && !midM) midM = uid;
  }
  return freeM || defM || midM || fam.members[0];
}
// 家族别名/familyUid → 当前活跃档 modelUid (对外干净名解析); 已是具体档 uid 则返 null
function _resolveFamilyAlias(model, deps) {
  if (!model) return null;
  try {
    const idx = buildFamilyIndex(deps);
    if (idx.byUid.has(model)) return null; // 已是精确档位 · 不改
    const want = String(model).toLowerCase();
    const cfg = (deps && deps.cfg) || loadConfig();
    for (const [fu, fam] of idx.families) {
      if (
        fam.aliasSlug === want ||
        String(fu).toLowerCase() === want ||
        _slug(fam.familyLabel) === want
      )
        return _familyActiveUid(fam, idx, cfg);
    }
  } catch (_) {}
  return null;
}
// 模型外接选择: 判某模型(对外名/uid/家族别名)是否被用户排除(不对外反代)。
//   命中原名或其家族别名解析出的活跃档 uid, 皆视为禁用。空列表=全通。
function _isModelDisabled(cfg, model, deps) {
  const dis = (cfg && cfg.disabledModels) || [];
  if (!dis.length || !model) return false;
  if (dis.indexOf(model) >= 0) return true;
  try {
    const aliased = _resolveFamilyAlias(model, deps);
    if (aliased && dis.indexOf(aliased) >= 0) return true;
  } catch (_) {}
  return false;
}

// 家族归组摘要(供状态面 + /v1/models 别名): 每族活跃档 + 各档色/免费态
function familySummary(deps, models) {
  const idx = buildFamilyIndex(deps);
  const cfg = (deps && deps.cfg) || loadConfig();
  const mById = new Map((models || []).map((m) => [m.id, m]));
  const out = [];
  for (const [fu, fam] of idx.families) {
    const members = fam.members
      .filter((u) => mById.has(u))
      .map((u) => {
        const m = mById.get(u);
        const info = idx.byUid.get(u) || {};
        return {
          id: u,
          tier: info.tier,
          label: m.label,
          color: m.color,
          free: !!m.free,
          note: m.note,
        };
      });
    if (!members.length) continue;
    let activeUid = _familyActiveUid(fam, idx, cfg);
    if (!members.some((x) => x.id === activeUid)) activeUid = members[0].id;
    out.push({
      familyUid: fu,
      familyLabel: fam.familyLabel,
      aliasSlug: fam.aliasSlug,
      provider: fam.provider,
      activeUid,
      multi: members.length > 1,
      members,
    });
  }
  return out;
}

// 模块级·官方付费配额观测态: "unknown" | "ok" | "exhausted"
//   实际官方反代调用命中配额错误 → exhausted; 成功 → ok; 供面板红/绿如实着色。
let _premiumQuota = "unknown";
function setPremiumQuota(s) {
  if (s === "ok" || s === "exhausted" || s === "unknown") _premiumQuota = s;
}
function getPremiumQuota() {
  return _premiumQuota;
}

// 给一个模型条目判定 {reverse, color, status, note}
function _classify(entry, deps) {
  // 显式 stub
  if (entry.reverse === "stub")
    return { color: "green", status: "stub", note: "传输自验" };
  // 已配第三方渠道(模型路由/provider) → 经渠道反代·不受官方配额限
  if (entry.routed)
    return {
      color: "green",
      status: "channel",
      note: "经渠道 " + (entry.provider || ""),
    };
  // 官方免费档 → 恒可反代
  if (entry.free)
    return { color: "green", status: "free", note: "免费 · 官方直通" };
  // 官方付费档 → 依配额观测
  const q =
    (deps && typeof deps.premiumQuota === "string"
      ? deps.premiumQuota
      : null) || _premiumQuota;
  if (q === "ok")
    return { color: "green", status: "premium", note: "有配额 · 官方直通" };
  if (q === "exhausted")
    return { color: "red", status: "exhausted", note: "配额耗尽 · 待重置" };
  return { color: "amber", status: "premium", note: "付费档 · 配额未探测" };
}

function listModels(deps) {
  deps = deps || {};
  const out = [];
  const byId = new Map();
  const cfg = (deps.getEaConfig && deps.getEaConfig()) || {};
  const routes = (cfg.daoRoutes && cfg.daoRoutes.routes) || {};
  const providers = cfg.providers || {};
  const add = (id, fields) => {
    if (!id) return null;
    let e = byId.get(id);
    if (e) {
      Object.assign(e, fields || {});
      return e;
    }
    e = Object.assign(
      { id, object: "model", created: 0, owned_by: "dao-revproxy" },
      fields || {},
    );
    byId.set(id, e);
    out.push(e);
    return e;
  };

  // ③ 官方全量目录(最广底·先铺) → 免费/付费档着色
  let catalog = [];
  try {
    catalog = (deps.getModelCatalog && deps.getModelCatalog()) || [];
  } catch (_) {}
  for (const m of catalog) {
    if (!m || !m.modelUid) continue;
    const mult = m.creditMultiplier;
    const costTier = m.modelCostTier || m.costTier || "";
    add(m.modelUid, {
      owned_by: _provLabel(m.provider),
      label: m.label || m.modelUid,
      provider: _provLabel(m.provider),
      providerRaw: m.provider || "",
      creditMultiplier: typeof mult === "number" ? mult : null,
      costTier,
      free: _isFreeTier(costTier, mult),
      official: true,
      reverse: "official",
      routed: false,
      capabilities: m._capabilities || null,
      custom: m._customModel === true,
    });
  }

  // ④ 运行时官方家族(账号当前实见) → 标记 availableNow
  let fams = [];
  try {
    fams = (deps.getOfficialFamilies && deps.getOfficialFamilies()) || [];
  } catch (_) {}
  for (const f of fams) {
    const uid = f && (f.modelUid || f.uid || f.model);
    if (!uid) continue;
    const e = add(uid, {
      official: true,
      reverse: "official",
      availableNow: true,
    });
    if (e && !e.label && f.label) e.label = f.label;
    if (e) e.availableNow = true;
  }

  // ① 模型路由表(第三方渠道/stub) → 覆盖为 channel/stub·绿
  for (const [uid, r] of Object.entries(routes)) {
    if (r && r._bridgeManaged && r._bridgeOutputModel && uid !== r._bridgeOutputModel)
      continue;
    const prov = (r && r.provider) || "routed";
    const isStub = prov === "builtin-stub";
    const customModelRef = (r && (r._customModelRef || r._customModelId)) || "";
    const customRecord = customModelRef && cfg.customModels
      ? cfg.customModels[customModelRef]
      : null;
    const sharedChannels = r && Array.isArray(r.channelPriority)
      ? r.channelPriority
      : customRecord && Array.isArray(customRecord.channels)
        ? customRecord.channels
        : [];
    add(uid, {
      owned_by: prov,
      provider: prov,
      routed: !isStub,
      reverse: isStub ? "stub" : "channel",
      dao_route: { provider: prov, model: r && r.model },
      dao_bridge: !!(r && r._bridgeManaged),
      dao_bridge_id: (r && r._bridgeId) || undefined,
      dao_target_protocols: (r && r._targetProtocols) || undefined,
      customModelRef: customModelRef || undefined,
      channelStrategy: (r && r.channelStrategy) || (customRecord && customRecord.channelStrategy) || undefined,
      channelPriority: sharedChannels.length
        ? sharedChannels.map((channel) => ({
            provider: channel.provider,
            model: channel.model || channel.upstreamModel,
            protocol: channel.sourceProtocol || channel.protocol || "",
            reasoningLevel: channel.reasoningLevel || "off",
          }))
        : undefined,
      capabilities: (r && r.capabilities) || undefined,
      reasoningLevel: (r && r.reasoningLevel) || undefined,
    });
  }

  // ② provider 显式 models → channel·绿
  for (const [name, p] of Object.entries(providers)) {
    const ms = (p && p.models) || [];
    for (const m of ms)
      add(m, {
        owned_by: name,
        provider: name,
        routed: true,
        reverse: "channel",
        capabilities: p.modelCapabilities && p.modelCapabilities[m],
      });
  }

  // 着色 + 计数 + 外接开关标记(exposed: 是否对外反代 · false=用户已排除)
  //   注: 此处 cfg 为 EaConfig(渠道/路由), 反代配置须取 deps.cfg / loadConfig()。
  const _rpCfg = (deps && deps.cfg) || loadConfig();
  const _cfgDis = (_rpCfg && _rpCfg.disabledModels) || [];
  for (const e of out) {
    const c = _classify(e, deps);
    e.color = c.color;
    e.status = c.status;
    e.note = c.note;
    e.exposed = _cfgDis.indexOf(e.id) < 0;
  }
  // 家族·档位标注 (供前端按家族归组 + 档位热切换 · 每档保留独立配额色)
  try {
    const idx = buildFamilyIndex(deps);
    const cfg = (deps && deps.cfg) || loadConfig();
    const active = {};
    for (const [fu, fam] of idx.families)
      active[fu] = _familyActiveUid(fam, idx, cfg);
    for (const e of out) {
      const info = idx.byUid.get(e.id);
      if (info) {
        e.familyUid = info.familyUid;
        e.familyLabel = info.familyLabel;
        e.tier = info.tier;
        e.activeTier = active[info.familyUid] === e.id;
      } else {
        // 渠道/路由独有 uid → 自成一族(单档)
        e.familyUid = "__solo__" + e.id;
        e.familyLabel = e.label || e.id;
        e.tier = "base";
        e.activeTier = true;
      }
    }
  } catch (_) {}
  return out;
}

function modelStats(models) {
  const s = { total: models.length, green: 0, red: 0, amber: 0, free: 0, channel: 0, official: 0, exposed: 0, disabled: 0 };
  for (const m of models) {
    if (m.color === "green") s.green++;
    else if (m.color === "red") s.red++;
    else if (m.color === "amber") s.amber++;
    if (m.status === "free") s.free++;
    if (m.reverse === "channel" || m.reverse === "stub") s.channel++;
    if (m.reverse === "official") s.official++;
    if (m.exposed === false) s.disabled++;
    else s.exposed++;
  }
  return s;
}

// ── 入站归一 ──────────────────────────────────────────────────────────────
// 把 OpenAI / Anthropic 请求体归一为内部统一结构。
function normalizeInbound(kind, body) {
  body = body || {};
  let system = "";
  let messages = [];
  let tools = body.tools || null;
  let toolChoice = body.tool_choice || null;
  if (kind === "anthropic") {
    system = _flattenContent(body.system);
    messages = _anthropicMessagesToOpenAI(body.messages || []);
    tools = (body.tools || []).map((tool) => ({
      type: "function",
      function: {
        name: tool.name || "",
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }));
    toolChoice = _anthropicToolChoiceToOpenAI(body.tool_choice);
  } else if (kind === "openai-responses") {
    system = _flattenContent(body.instructions);
    messages = _responsesInputToOpenAI(body.input);
  } else if (kind === "gemini") {
    system = _flattenGeminiParts(body.systemInstruction?.parts);
    messages = _geminiContentsToOpenAI(body.contents || []);
    tools = _geminiToolsToOpenAI(body.tools || []);
    toolChoice = _geminiToolChoiceToOpenAI(body.toolConfig);
  } else {
    for (const message of body.messages || []) {
      if (message.role === "system" || message.role === "developer") {
        system += (system ? "\n" : "") + _flattenContent(message.content);
      } else {
        messages.push(Object.assign({}, message));
      }
    }
  }
  return {
    system,
    messages,
    model: body.model || "",
    stream: body.stream === true,
    tools,
    toolChoice,
    maxTokens:
      body.max_tokens ||
      body.max_completion_tokens ||
      body.max_output_tokens ||
      body.maxOutputTokens ||
      body.generationConfig?.maxOutputTokens ||
      0,
    temperature:
      typeof body.temperature === "number"
        ? body.temperature
        : body.generationConfig?.temperature,
    topP:
      typeof body.top_p === "number" ? body.top_p : body.generationConfig?.topP,
    stop: body.stop || body.stop_sequences || body.generationConfig?.stopSequences,
    reasoningEffort:
      ["off", "none", "disabled"].includes(
        String(body.reasoning_effort ?? body.reasoning?.effort ?? "").toLowerCase(),
      )
        ? null
        : body.reasoning_effort || body.reasoning?.effort || null,
    thinkingEnabled:
      body.thinking?.type === "disabled" ||
      body.thinkingConfig?.thinkingBudget === 0 ||
      body.generationConfig?.thinkingConfig?.thinkingBudget === 0 ||
      ["off", "none", "disabled"].includes(
        String(body.reasoning_effort ?? body.reasoning?.effort ?? "").toLowerCase(),
      )
        ? false
        : !!body.thinking || !!body.reasoning || !!body.thinkingConfig ||
          !!body.generationConfig?.thinkingConfig,
    thinkingBudget:
      body.thinking?.budget_tokens ??
      body.reasoning?.budget_tokens ??
      body.thinkingConfig?.thinkingBudget ??
      body.generationConfig?.thinkingConfig?.thinkingBudget ??
      null,
    reasoningSpecified:
      body.reasoning_effort != null ||
      body.reasoning != null ||
      body.thinking != null ||
      body.thinkingConfig != null ||
      body.generationConfig?.thinkingConfig != null,
    promptCacheKey: body.prompt_cache_key || null,
    clientKind: kind,
  };
}

function _flattenContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b.text === "string") return b.text;
        if (b && typeof b.input_text === "string") return b.input_text;
        if (b && typeof b.output_text === "string") return b.output_text;
        return "";
      })
      .join("");
  return "";
}

function _anthropicMessagesToOpenAI(messages) {
  const out = [];
  for (const message of messages || []) {
    const textParts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const block of Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: message.content || "" }]) {
      if (block?.type === "text" && block.text) textParts.push(block.text);
      else if (block?.type === "thinking" && block.thinking) textParts.push(block.thinking);
      else if (block?.type === "tool_use") {
        toolCalls.push({
          id: block.id || _genId("call"),
          type: "function",
          function: {
            name: block.name || "",
            arguments: JSON.stringify(block.input || {}),
          },
        });
      } else if (block?.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id || "",
          content: _flattenContent(block.content),
        });
      }
    }
    if (textParts.length || toolCalls.length) {
      const converted = { role: message.role || "user", content: textParts.join("") };
      if (toolCalls.length) converted.tool_calls = toolCalls;
      out.push(converted);
    }
    out.push(...toolResults);
  }
  return out;
}

function _anthropicToolChoiceToOpenAI(choice) {
  if (!choice) return null;
  if (choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (choice.type === "any") return "required";
  if (choice.type === "tool")
    return { type: "function", function: { name: choice.name || "" } };
  return null;
}

function _responsesInputToOpenAI(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const out = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (!item) continue;
    if (item.type === "function_call") {
      out.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item.call_id || item.id || _genId("call"),
            type: "function",
            function: { name: item.name || "", arguments: item.arguments || "{}" },
          },
        ],
      });
    } else if (item.type === "function_call_output") {
      out.push({
        role: "tool",
        tool_call_id: item.call_id || "",
        content: _flattenContent(item.output),
      });
    } else {
      out.push({
        role: item.role === "assistant" ? "assistant" : "user",
        content: _responsesContentToOpenAI(item.content),
      });
    }
  }
  return out;
}

function _responsesContentToOpenAI(content) {
  if (typeof content === "string") return content;
  const parts = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text")
      parts.push({ type: "text", text: part.text || "" });
    else if (part?.type === "input_image")
      parts.push({ type: "image_url", image_url: { url: part.image_url || part.file_url || "" } });
  }
  return parts.length ? parts : "";
}

function _flattenGeminiParts(parts) {
  return (parts || [])
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function _geminiContentsToOpenAI(contents) {
  const out = [];
  for (const content of contents || []) {
    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const part of content.parts || []) {
      if (typeof part.text === "string") parts.push({ type: "text", text: part.text });
      else if (part.inlineData?.data)
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${part.inlineData.mimeType || "application/octet-stream"};base64,${part.inlineData.data}`,
          },
        });
      else if (part.fileData?.fileUri)
        parts.push({ type: "image_url", image_url: { url: part.fileData.fileUri } });
      else if (part.functionCall)
        toolCalls.push({
          id: part.functionCall.id || _genId("call"),
          type: "function",
          function: {
            name: part.functionCall.name || "",
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        });
      else if (part.functionResponse)
        toolResults.push({
          role: "tool",
          name: part.functionResponse.name || "",
          tool_call_id: part.functionResponse.id || "",
          content: JSON.stringify(part.functionResponse.response || {}),
        });
    }
    if (parts.length || toolCalls.length) {
      const message = {
        role: content.role === "model" ? "assistant" : "user",
        content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
      };
      if (toolCalls.length) message.tool_calls = toolCalls;
      out.push(message);
    }
    out.push(...toolResults);
  }
  return out;
}

function _geminiToolsToOpenAI(toolGroups) {
  const out = [];
  for (const group of toolGroups || []) {
    for (const fn of group.functionDeclarations || []) {
      out.push({
        type: "function",
        function: {
          name: fn.name || "",
          description: fn.description || "",
          parameters: fn.parameters || { type: "object", properties: {} },
        },
      });
    }
  }
  return out;
}

function _geminiToolChoiceToOpenAI(toolConfig) {
  const cfg = toolConfig?.functionCallingConfig;
  if (!cfg) return null;
  if (cfg.mode === "NONE") return "none";
  if (cfg.mode === "ANY") {
    const name = cfg.allowedFunctionNames && cfg.allowedFunctionNames[0];
    return name ? { type: "function", function: { name } } : "required";
  }
  return "auto";
}

// model 是否属官方目录/家族 → {free,label,provider} 或 null
function _officialInfo(model, deps) {
  if (!model || !deps) return null;
  try {
    const cat = (deps.getModelCatalog && deps.getModelCatalog()) || [];
    for (const m of cat) {
      if (m && m.modelUid === model)
        return {
          free: _isFreeTier(m.modelCostTier || m.costTier, m.creditMultiplier),
          label: m.label || model,
          provider: _provLabel(m.provider),
        };
    }
  } catch (_) {}
  try {
    const fams = (deps.getOfficialFamilies && deps.getOfficialFamilies()) || [];
    for (const f of fams) {
      const uid = f && (f.modelUid || f.uid || f.model);
      if (uid === model)
        return { free: !!f.free, label: f.label || model, provider: "Official" };
    }
  } catch (_) {}
  return null;
}

// ── 路由解析 ──────────────────────────────────────────────────────────────
// model(对外名/uid) → 真上游 {provName, provCfg, upstreamModel, proto}
function resolveTarget(model, deps) {
  const cfg = (deps.getEaConfig && deps.getEaConfig()) || {};
  const routes = (cfg.daoRoutes && cfg.daoRoutes.routes) || {};
  const providers = cfg.providers || {};
  // 家族别名(如 glm-5.1) / familyUid → 当前活跃档 modelUid (档位热切换之对外干净名)
  const aliased = _resolveFamilyAlias(model, deps);
  if (aliased) model = aliased;
  let route = routes[model];
  // 经 router.resolveRoute 解析同族档位(与正向推理同一张表)
  if (!route && deps.resolveRoute) {
    try {
      const r = deps.resolveRoute(model);
      if (r && r.route) route = r.route;
    } catch (_) {}
  }
  if (route && route._customModelRef && deps.resolveRoute) {
    try {
      const resolved = deps.resolveRoute(model);
      if (resolved && resolved.route) route = resolved.route;
    } catch (_) {}
  }
  // 直接以 provider 名作 model 前缀: "providerName/realModel"
  if (!route && model.indexOf("/") > 0) {
    const [pn, ...rest] = model.split("/");
    if (providers[pn]) route = { provider: pn, model: rest.join("/") };
  }
  // 无第三方渠道 → 官方直通(若 model 属官方目录/家族): 复用上游官方推理链
  if (!route) {
    const info = _officialInfo(model, deps);
    if (info) {
      return {
        official: true,
        upstreamModel: model,
        free: info.free,
        label: info.label,
        provider: info.provider,
      };
    }
    return null;
  }
  const provName = route.provider;
  if (provName === "builtin-stub") {
    return { provName, builtin: true, route, upstreamModel: route.model };
  }
  const provCfg = providers[provName];
  if (!provCfg) return null;
  const adapters = _getAdapters();
  const proto = route.sourceProtocol ||
    (adapters
      ? adapters.detectProtocol(provCfg, route.model || model)
      : provCfg.protocol || "openai-chat");
  return {
    provName,
    provCfg,
    proto,
    route,
    upstreamModel: route.model || model,
  };
}

function _routeChannelTargets(primary, deps) {
  if (!primary || primary.official || primary.builtin) return [primary].filter(Boolean);
  const route = primary.route || {};
  const cfg = (deps.getEaConfig && deps.getEaConfig()) || {};
  const providers = cfg.providers || {};
  const configured = Array.isArray(route.channelPriority) ? route.channelPriority : [];
  if (configured.length < 2 || route.autoFallback === false) return [primary];
  const seen = new Set();
  const targets = [];
  const add = (entry) => {
    const provider = String((entry && entry.provider) || "").trim();
    const model = String((entry && (entry.model || entry.upstreamModel)) || "").trim();
    const provCfg = providers[provider];
    const key = provider + "|" + model;
    if (!provider || !model || !provCfg || provCfg.enabled === false || seen.has(key)) return;
    seen.add(key);
    const adapters = _getAdapters();
    const proto = entry.sourceProtocol || entry.protocol ||
      (adapters ? adapters.detectProtocol(provCfg, model) : provCfg.protocol || "openai-chat");
    targets.push({
      provName: provider,
      provCfg,
      proto,
      route: Object.assign({}, route, entry),
      upstreamModel: model,
    });
  };
  configured.forEach(add);
  add({ provider: primary.provName, model: primary.upstreamModel });
  return targets.length ? targets : [primary];
}

// ── 双路互补 (道并行而不相悖·外接↔反代) ────────────────────────────────────
// 上游错误是否「限流/配额」类 → 可在未出首字节时切另一路(而非直接报错给客户端)。
function _isRetryableErr(msg) {
  return /rate.?limit|resets in|too many requests|\b429\b|\b402\b|quota|exhaust|配额|governor|insufficient_quota|precondition|overloaded|capacity/i.test(
    String(msg || ""),
  );
}
// 给主目标求「另一路」备援目标: 官方直通 ↔ 同族已配第三方渠道。无备路则 null。
function _altTarget(primary, model, deps) {
  try {
    if (!primary) return null;
    const idx = buildFamilyIndex(deps);
    const primUid = primary.upstreamModel || model;
    const pinfo = idx.byUid.get(primUid);
    const fam = pinfo && idx.families.get(pinfo.familyUid);
    if (primary.official) {
      // 官方直通遇限流 → 找同族已配渠道(外接)接手
      const cfg = (deps.getEaConfig && deps.getEaConfig()) || {};
      const routes = (cfg.daoRoutes && cfg.daoRoutes.routes) || {};
      const cands = [];
      if (fam) {
        for (const uid of fam.members) cands.push(uid);
        if (fam.aliasSlug) cands.push(fam.aliasSlug);
        if (fam.familyLabel) cands.push(fam.familyLabel);
      }
      cands.push(model);
      for (const key of cands) {
        if (key && routes[key]) {
          const t = resolveTarget(key, deps);
          if (t && !t.official && !t.builtin) return t;
        }
      }
      return null;
    }
    // 第三方渠道遇限流 → 若模型属官方目录/家族, 以同族官方直通接手(优先免费档)
    let offUid = null;
    if (fam) {
      for (const uid of fam.members) {
        const mi = idx.byUid.get(uid);
        if (mi && mi.free) {
          offUid = uid;
          break;
        }
      }
      if (!offUid)
        offUid = _familyActiveUid(fam, idx, (deps && deps.cfg) || loadConfig());
    } else if (_officialInfo(model, deps)) {
      offUid = model;
    }
    if (offUid) {
      const info = _officialInfo(offUid, deps);
      if (info)
        return {
          official: true,
          upstreamModel: offUid,
          free: info.free,
          label: info.label,
          provider: info.provider,
        };
    }
    return null;
  } catch (_) {
    return null;
  }
}
// 解析出「主路 + 备路」候选列表(双路开启时含备路)。
function resolveTargets(model, deps) {
  const primary = resolveTarget(model, deps);
  if (!primary) return [];
  const configured = _routeChannelTargets(primary, deps);
  if (configured.length > 1) return configured;
  const cfg = (deps && deps.cfg) || loadConfig();
  if (cfg.dualPath === false) return [primary];
  const alt = _altTarget(primary, model, deps);
  return alt ? [primary, alt] : [primary];
}

// ── 上游调用(流式) ─────────────────────────────────────────────────────────
// 以目标渠道真协议发请求, 边收边把 SSE 行解析成统一 delta, 回调 onDelta。
function callUpstream(target, norm, deps, handlers) {
  const { provCfg, proto, upstreamModel } = target;
  const adapters = _getAdapters();
  const adapter = adapters && adapters.adapterFor(proto || "openai-chat");
  if (!adapter) {
    handlers.onError(new Error("unsupported provider protocol: " + proto));
    return;
  }
  const baseUrl = (provCfg.baseUrl || "").replace(/\/$/, "");
  const completionPath = adapter.getCompletionPath(provCfg, upstreamModel, true);
  let url;
  try {
    url = new URL(_joinProviderEndpoint(baseUrl, completionPath));
  } catch (e) {
    handlers.onError(new Error("bad provider baseUrl: " + baseUrl));
    return;
  }
  const isHttps = url.protocol === "https:";
  const mod = isHttps ? https : http;

  // 出站请求体 (本源观照: applyInvert 时对 system 施 invertSP)
  let sys = norm.system || "";
  if (deps.cfg && deps.cfg.applyInvert && sys && deps.invertSP) {
    try {
      sys = deps.invertSP(sys) || sys;
    } catch (_) {}
  }
  // ★ 出站脱敏: revproxy.json.outboundRedact 开启时, 扫 system + messages 高置信度密钥
  const _redact = _getOutboundRedact();
  if (_redact && deps.cfg && deps.cfg.outboundRedact && deps.cfg.outboundRedact.enabled === true) {
    try {
      const rset = _redact.resolveSettings(deps.cfg, null);
      const combined = sys
        ? [{ role: "system", content: sys }].concat(norm.messages || [])
        : norm.messages || [];
      const result = _redact.redactMessages(combined, rset);
      if (result.blocked) {
        const err = new Error("request blocked by outbound redaction policy");
        err.code = "OUTBOUND_REDACT_BLOCKED";
        handlers.onError(err);
        return;
      }
      if (result.changed) {
        if (sys) {
          sys = result.messages[0].content;
          norm.messages = result.messages.slice(1);
        } else {
          norm.messages = result.messages;
        }
      }
      if (result.findings && result.findings.length > 0 && deps.log) {
        deps.log(
          `[revproxy] outbound-redact mode=${rset.mode} findings=${result.findings
            .map((f) => f.name + ":" + f.count)
            .join(",")}`,
        );
      }
    } catch (e) {
      if (deps.log) deps.log(`[revproxy] outbound-redact error: ${e.message}`);
    }
  }
  const maxTokens =
    norm.maxTokens || (deps.cfg && deps.cfg.defaultMaxTokens) || 4096;

  const promptCacheKey =
    norm.promptCacheKey ||
    (proto === "openai-responses"
      ? crypto
          .createHash("sha256")
          .update(JSON.stringify([upstreamModel, sys, norm.tools || []]))
          .digest("hex")
          .slice(0, 32)
      : null);
  const route = target.route || {};
  // Module ⑧ owns the effective effort at the local bridge. Codex may keep
  // sending the effort read at process start, so a hot route must override it.
  const useRouteReasoning =
    route._codexManaged === true || norm.reasoningSpecified !== true;
  const payloadObj = adapter.buildRequest({
    model: upstreamModel,
    messages: sys
      ? [{ role: "system", content: sys }].concat(norm.messages || [])
      : norm.messages || [],
    system: sys,
    tools: norm.tools,
    toolChoice: norm.toolChoice,
    maxOutputTokens: maxTokens,
    stream: true,
    thinkingEnabled: useRouteReasoning ? !!route.thinkingEnabled : norm.thinkingEnabled,
    thinkingBudget: useRouteReasoning ? route.thinkingBudget || null : norm.thinkingBudget,
    reasoningEffort: useRouteReasoning ? route.reasoningEffort || null : norm.reasoningEffort,
    promptCacheKey,
    temperature: norm.temperature,
    topP: norm.topP,
    stop: norm.stop,
  });
  delete payloadObj.__dao_stream;
  if (proto === "openai-chat" && payloadObj.stream)
    payloadObj.stream_options = { include_usage: true };
  // ★ OmniRoute 借鉴: 出站前最终守卫 · adaptive thinking 格式规范化
  //   不论 buildRequest 还是透传路径, 出站前一律扫净旧格式 thinking:{type:"enabled"} → {type:"adaptive"}
  //   道义: 第十六章「守情表也」· 守者最终防护 · 万物旁作吾以观其复
  const _tg = _getThinkingGuard();
  if (_tg && proto === "anthropic") {
    try {
      const _gr = _tg.guardRequest(payloadObj, upstreamModel);
      if (_gr.converted) {
        Object.assign(payloadObj, typeof _gr.body === "object" ? _gr.body : JSON.parse(_gr.body));
      }
    } catch (_) {}
  }
  const payload = JSON.stringify(payloadObj);

  const builtOpts = adapter.buildRequestOpts(provCfg, payloadObj, url) || {};
  const headers = Object.assign({}, builtOpts.headers || {}, {
    "Content-Length": String(Buffer.byteLength(payload)),
  });
  const agent = deps.getProxyAgent ? deps.getProxyAgent(isHttps) : null;

  const reqOpts = {
    hostname: url.hostname,
    port: parseInt(url.port || (isHttps ? "443" : "80"), 10),
    path: url.pathname + (url.search || ""),
    method: "POST",
    headers,
    rejectUnauthorized: process.env.DAO_TLS_INSECURE !== "1",
  };
  if (agent) reqOpts.agent = agent;

  const upReq = mod.request(reqOpts, (upRes) => {
    if (upRes.statusCode >= 400) {
      let errBody = "";
      upRes.on("data", (c) => (errBody += c));
      upRes.on("end", () =>
        handlers.onError(
          new Error("upstream " + upRes.statusCode + ": " + errBody.slice(0, 400)),
          upRes.statusCode,
        ),
      );
      return;
    }
    handlers.onOpen && handlers.onOpen(upRes.statusCode || 200);
    const contentType = String(upRes.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      let unaryBody = "";
      upRes.setEncoding("utf8");
      upRes.on("data", (chunk) => (unaryBody += chunk));
      upRes.on("end", () => {
        const parsed = adapter.parseUnaryResponse(unaryBody);
        if (!parsed) {
          handlers.onError(new Error("upstream returned unrecognized response"));
          return;
        }
        handlers.onDelta(Object.assign({ type: "delta" }, parsed));
        handlers.onDone();
      });
      upRes.on("error", (e) => handlers.onError(e));
      return;
    }
    let buf = "";
    let eventType = "";
    upRes.setEncoding("utf8");
    upRes.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        line = line.replace(/\r$/, "").trim();
        if (!line) {
          eventType = "";
          continue;
        }
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let parsed;
        try {
          parsed = adapter.parseSSELine(data, eventType);
        } catch (_) {
          continue;
        }
        if (!parsed) continue;
        if (parsed.type === "delta") handlers.onDelta(parsed);
        else if (parsed.usage) handlers.onDelta({ usage: parsed.usage });
      }
    });
    upRes.on("end", () => handlers.onDone());
    upRes.on("error", (e) => handlers.onError(e));
  });
  upReq.on("error", (e) => handlers.onError(e));
  // v9.9.339 · 反者道之动 · 撤销 revproxy 流式请求秒数硬限 · AI 自然而止
  //   本源: 推理静默数分钟, 120s socket 超时 destroy → onError 报错帧 → 对话中途截断
  //   道并行防泄漏: 关默认超时(0) + TCP keepalive 探活, 连接真死才 error 收束
  upReq.setTimeout(0);
  upReq.on("socket", (s) => {
    try {
      s.setKeepAlive(true, 45000);
    } catch {}
  });
  upReq.end(payload);
}

const RESPONSES_COMPACT_FIELDS = Object.freeze([
  "input",
  "instructions",
  "previous_response_id",
  "parallel_tool_calls",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "service_tier",
]);

function _responsesCompactPayload(body, model) {
  const payload = { model };
  for (const field of RESPONSES_COMPACT_FIELDS) {
    if (body && body[field] !== undefined) payload[field] = body[field];
  }
  return payload;
}

function _callResponsesCompact(target, body, deps) {
  return new Promise((resolve) => {
    if (!target || target.official || target.builtin) {
      resolve({ statusCode: 501, headers: {}, body: Buffer.from(JSON.stringify({ error: { message: "Responses compaction requires an external Responses channel" } })) });
      return;
    }
    if (target.proto !== "openai-responses") {
      resolve({ statusCode: 400, headers: {}, body: Buffer.from(JSON.stringify({ error: { message: "Responses compaction is only available for Responses channels" } })) });
      return;
    }
    const provCfg = target.provCfg || {};
    const adapters = _getAdapters();
    const adapter = adapters && adapters.adapterFor("openai-responses");
    const baseUrl = String(provCfg.baseUrl || "").replace(/\/+$/, "");
    const compactPath = provCfg.responsesCompactPath || "/v1/responses/compact";
    let url;
    try {
      url = new URL(_joinProviderEndpoint(baseUrl, compactPath));
    } catch (_) {
      resolve({ statusCode: 400, headers: {}, body: Buffer.from(JSON.stringify({ error: { message: "bad provider baseUrl: " + baseUrl } })) });
      return;
    }
    const payloadObject = _responsesCompactPayload(body, target.upstreamModel);
    const payload = JSON.stringify(payloadObject);
    const built = adapter ? adapter.buildRequestOpts(provCfg, payloadObject, url) : {};
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;
    const headers = Object.assign({}, (built && built.headers) || {}, {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
    });
    const options = {
      hostname: url.hostname,
      port: parseInt(url.port || (isHttps ? "443" : "80"), 10),
      path: url.pathname + (url.search || ""),
      method: "POST",
      headers,
      rejectUnauthorized: process.env.DAO_TLS_INSECURE !== "1",
    };
    const agent = deps.getProxyAgent ? deps.getProxyAgent(isHttps) : null;
    if (agent) options.agent = agent;
    const request = mod.request(options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        statusCode: response.statusCode || 502,
        headers: response.headers || {},
        body: Buffer.concat(chunks),
      }));
      response.on("error", (error) => resolve({ statusCode: 502, headers: {}, body: Buffer.from(JSON.stringify({ error: { message: error.message } })) }));
    });
    request.on("error", (error) => resolve({ statusCode: 502, headers: {}, body: Buffer.from(JSON.stringify({ error: { message: error.message } })) }));
    request.setTimeout(0);
    request.on("socket", (socket) => {
      try { socket.setKeepAlive(true, 45000); } catch (_) {}
    });
    request.end(payload);
  });
}

async function _forwardResponsesCompact(targets, body, deps) {
  const candidates = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
  let last = null;
  for (let index = 0; index < candidates.length; index++) {
    const result = await _callResponsesCompact(candidates[index], body, deps);
    last = result;
    if (result.statusCode >= 200 && result.statusCode < 300) return result;
    const retryable = result.statusCode === 429 || result.statusCode >= 500;
    if (!retryable) return result;
  }
  return last || { statusCode: 503, headers: {}, body: Buffer.from(JSON.stringify({ error: { message: "No Responses compaction channel is available" } })) };
}

function _joinProviderEndpoint(baseUrl, completionPath) {
  if (/^https?:\/\//i.test(completionPath || "")) return completionPath;
  const base = String(baseUrl || "").replace(/\/+$/, "");
  let endpoint = String(completionPath || "");
  const baseMatch = base.match(/\/(v\d+(?:beta)?)$/i);
  const pathMatch = endpoint.match(/^\/(v\d+(?:beta)?)(\/|$)/i);
  if (baseMatch && pathMatch && baseMatch[1].toLowerCase() === pathMatch[1].toLowerCase())
    endpoint = endpoint.slice(pathMatch[1].length + 1) || "/";
  return base + (endpoint.startsWith("/") ? endpoint : "/" + endpoint);
}

// ── 出站(回客户端)编码 ───────────────────────────────────────────────────
function _genId(prefix) {
  return (prefix || "chatcmpl") + "-" + crypto.randomBytes(12).toString("hex");
}

function _toolCallIndex(call, fallback) {
  return Number.isInteger(call?.index) ? call.index : fallback || 0;
}

function _mergeToolCall(state, call, mode) {
  const index = _toolCallIndex(call, state.size);
  const current = state.get(index) || {
    index,
    id: "",
    type: "function",
    function: { name: "", arguments: "" },
  };
  const fn = call?.function || {};
  current.id = call?.id || call?.callId || current.id || _genId("call");
  current.function.name = fn.name || call?.name || current.function.name;
  const args =
    fn.arguments !== undefined
      ? fn.arguments
      : call?.arguments !== undefined
        ? call.arguments
        : call?.partialJson;
  if (args !== undefined) {
    const text = typeof args === "string" ? args : JSON.stringify(args || {});
    current.function.arguments =
      mode === "replace" ? text : current.function.arguments + text;
  }
  state.set(index, current);
  return current;
}

function _mergeUsage(previous, next) {
  const merged = {
    input: Number(previous && previous.input) || 0,
    output: Number(previous && previous.output) || 0,
    cached: Number(previous && previous.cached) || 0,
    cacheWrite: Number(previous && previous.cacheWrite) || 0,
  };
  if (!next || typeof next !== "object") return previous || null;
  for (const field of ["input", "output", "cached", "cacheWrite"]) {
    const value = Number(next[field]);
    if (Number.isFinite(value) && value > 0) merged[field] = value;
  }
  return merged;
}

function _emitOpenAIStream(res, model, gen, keepaliveOptions) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // ★ OmniRoute 借鉴: 早期 SSE 心跳 · 上游首字到达前周期发空 delta 保活
  //   道义: 橐钥虚而不淈 · 动而愈出 · 心跳保连接不死
  const kaMod = _getSseKeepalive();
  let _kaStarted = false;
  const _ka = kaMod
    ? kaMod.createKeepalive(res, "openai-chat", keepaliveOptions)
    : null;
  if (_ka) { _ka.start(); _kaStarted = true; }
  const _kaTouch = () => { if (_kaStarted) { _ka.stop(); _kaStarted = false; } };

  const id = _genId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model };
  const send = (delta, finish) => {
    res.write(
      "data: " +
        JSON.stringify(
          Object.assign({}, base, {
            choices: [
              { index: 0, delta: delta || {}, finish_reason: finish || null },
            ],
          }),
        ) +
        "\n\n",
    );
  };
  send({ role: "assistant", content: "" });
  let finishReason = "stop";
  const toolState = new Map();
  gen({
    onText: (t) => { _kaTouch(); send({ content: t }); },
    onThinking: (t) => { _kaTouch(); send({ reasoning_content: t }); },
    onToolCalls: (calls) => {
      _kaTouch();
      const deltas = [];
      for (const call of calls || []) {
        const merged = _mergeToolCall(toolState, call, "append");
        deltas.push({
          index: merged.index,
          id: call.id || undefined,
          type: "function",
          function: {
            name: call.function?.name || undefined,
            arguments: call.function?.arguments || "",
          },
        });
      }
      if (deltas.length) send({ tool_calls: deltas });
    },
    onToolCallStart: (call) => {
      _kaTouch();
      const merged = _mergeToolCall(toolState, call, "append");
      send({
        tool_calls: [
          {
            index: merged.index,
            id: merged.id,
            type: "function",
            function: { name: merged.function.name, arguments: "" },
          },
        ],
      });
    },
    onToolCallDelta: (call) => {
      _kaTouch();
      const merged = _mergeToolCall(toolState, call, "append");
      send({
        tool_calls: [
          {
            index: merged.index,
            function: { arguments: call.partialJson || call.arguments || "" },
          },
        ],
      });
    },
    onToolCallComplete: (call) => {
      _kaTouch();
      const index = _toolCallIndex(call, toolState.size);
      if (!toolState.has(index) || !toolState.get(index).function.arguments) {
        const merged = _mergeToolCall(toolState, call, "replace");
        send({
          tool_calls: [
            {
              index: merged.index,
              id: merged.id,
              type: "function",
              function: {
                name: merged.function.name,
                arguments: merged.function.arguments,
              },
            },
          ],
        });
      }
    },
    onFinish: (fr) => {
      _kaTouch();
      if (fr) finishReason = fr;
    },
    onEnd: () => {
      _kaTouch();
      send({}, toolState.size ? "tool_calls" : finishReason);
      res.write("data: [DONE]\n\n");
      res.end();
    },
    onError: (msg) => {
      _kaTouch();
      // SSE 头已以 200 下发, 无法再改状态码 → 以「错误对象」如实下发,
      // 绝不再把上游错误伪装成 assistant content(否则客户端把报错当正文,
      // 即长链路下"对话突然中断却收到一段奇怪文字"的根因)。
      const c = _classifyUpstreamError(msg);
      const errObj = { message: String(msg), type: c.type, code: c.code };
      if (c.retryAfter) errObj.retry_after = c.retryAfter;
      res.write("data: " + JSON.stringify({ error: errObj }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    },
  });
}

function _emitOpenAIUnary(res, model, gen) {
  const id = _genId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  let text = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage = null;
  const toolState = new Map();
  gen({
    onText: (t) => (text += t),
    onThinking: (t) => (reasoning += t),
    onFinish: (fr) => {
      if (fr) finishReason = fr;
    },
    onUsage: (u) => (usage = _mergeUsage(usage, u)),
    onToolCalls: (calls) =>
      (calls || []).forEach((call) => _mergeToolCall(toolState, call, "append")),
    onToolCallStart: (call) => _mergeToolCall(toolState, call, "append"),
    onToolCallDelta: (call) => _mergeToolCall(toolState, call, "append"),
    onToolCallComplete: (call) => _mergeToolCall(toolState, call, "replace"),
    onEnd: () => {
      const msg = { role: "assistant", content: text };
      if (reasoning) msg.reasoning_content = reasoning;
      if (toolState.size) msg.tool_calls = Array.from(toolState.values());
      const body = {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: msg,
            finish_reason: toolState.size ? "tool_calls" : finishReason,
          },
        ],
        usage: usage
          ? {
              prompt_tokens: usage.input || 0,
              completion_tokens: usage.output || 0,
              total_tokens: (usage.input || 0) + (usage.output || 0),
              prompt_tokens_details: { cached_tokens: usage.cached || 0 },
            }
          : undefined,
      };
      _json(res, 200, body);
    },
    onError: (msg) => {
      const c = _classifyUpstreamError(msg);
      _json(
        res,
        c.status,
        { error: { message: String(msg), type: c.type, code: c.code } },
        c.retryAfter ? { "Retry-After": String(c.retryAfter) } : undefined,
      );
    },
  });
}

function _emitAnthropicStream(res, model, gen, keepaliveOptions) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // ★ OmniRoute 借鉴: 早期 SSE 心跳 · Anthropic 格式发 event: ping 保活
  const kaMod = _getSseKeepalive();
  let _kaStarted = false;
  const _ka = kaMod
    ? kaMod.createKeepalive(res, "anthropic", keepaliveOptions)
    : null;
  if (_ka) { _ka.start(); _kaStarted = true; }
  const _kaTouch = () => { if (_kaStarted) { _ka.stop(); _kaStarted = false; } };

  const id = _genId("msg");
  const ev = (type, obj) => {
    res.write("event: " + type + "\ndata: " + JSON.stringify(obj) + "\n\n");
  };
  ev("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  ev("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  const toolState = new Map();
  const toolBlocks = new Map();
  let nextBlock = 1;
  let finishReason = "end_turn";
  let usage = null;
  const startTool = (call) => {
    const merged = _mergeToolCall(toolState, call, "append");
    if (!toolBlocks.has(merged.index)) {
      const blockIndex = nextBlock++;
      toolBlocks.set(merged.index, blockIndex);
      ev("content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: merged.id,
          name: merged.function.name,
          input: {},
        },
      });
    }
    return { merged, blockIndex: toolBlocks.get(merged.index) };
  };
  gen({
    onText: (t) => {
      _kaTouch();
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: t },
      });
    },
    onThinking: () => { _kaTouch(); },
    onToolCalls: (calls) => {
      _kaTouch();
      for (const call of calls || []) {
        const item = startTool(call);
        const args = call.function?.arguments || "";
        if (args)
          ev("content_block_delta", {
            type: "content_block_delta",
            index: item.blockIndex,
            delta: { type: "input_json_delta", partial_json: args },
          });
      }
    },
    onToolCallStart: (call) => {
      _kaTouch();
      return startTool(call);
    },
    onToolCallDelta: (call) => {
      _kaTouch();
      const item = startTool(call);
      const args = call.partialJson || call.arguments || "";
      if (args)
        ev("content_block_delta", {
          type: "content_block_delta",
          index: item.blockIndex,
          delta: { type: "input_json_delta", partial_json: args },
        });
    },
    onToolCallComplete: (call) => {
      _kaTouch();
      const index = _toolCallIndex(call, toolState.size);
      const hadArgs = toolState.has(index) && toolState.get(index).function.arguments;
      const item = startTool(call);
      if (!hadArgs) {
        const args = call.arguments || call.function?.arguments || "";
        if (args)
          ev("content_block_delta", {
            type: "content_block_delta",
            index: item.blockIndex,
            delta: { type: "input_json_delta", partial_json: args },
          });
      }
    },
    onFinish: (reason) => {
      _kaTouch();
      if (reason === "length") finishReason = "max_tokens";
      else if (reason === "tool_calls") finishReason = "tool_use";
    },
    onUsage: (value) => {
      _kaTouch();
      usage = _mergeUsage(usage, value);
    },
    onEnd: () => {
      _kaTouch();
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      for (const blockIndex of toolBlocks.values())
        ev("content_block_stop", { type: "content_block_stop", index: blockIndex });
      ev("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: toolBlocks.size ? "tool_use" : finishReason,
          stop_sequence: null,
        },
        usage: { output_tokens: (usage && usage.output) || 0 },
      });
      ev("message_stop", { type: "message_stop" });
      res.end();
    },
    onError: (msg) => {
      _kaTouch();
      // Anthropic SSE 错误以 `event: error` 如实下发, 不混入 text_delta 正文。
      const c = _classifyUpstreamError(msg);
      ev("error", {
        type: "error",
        error: {
          type: c.status === 429 ? "rate_limit_error" : "api_error",
          message: String(msg),
        },
      });
      res.end();
    },
  });
}

function _emitAnthropicUnary(res, model, gen) {
  const id = _genId("msg");
  let text = "";
  let usage = null;
  let finishReason = "end_turn";
  const toolState = new Map();
  gen({
    onText: (t) => (text += t),
    onThinking: () => {},
    onFinish: (reason) => {
      if (reason === "length") finishReason = "max_tokens";
      else if (reason === "tool_calls") finishReason = "tool_use";
    },
    onUsage: (u) => (usage = _mergeUsage(usage, u)),
    onToolCalls: (calls) =>
      (calls || []).forEach((call) => _mergeToolCall(toolState, call, "append")),
    onToolCallStart: (call) => _mergeToolCall(toolState, call, "append"),
    onToolCallDelta: (call) => _mergeToolCall(toolState, call, "append"),
    onToolCallComplete: (call) => _mergeToolCall(toolState, call, "replace"),
    onEnd: () => {
      const content = [];
      if (text) content.push({ type: "text", text });
      for (const call of toolState.values()) {
        let input = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = { value: call.function.arguments || "" };
        }
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input,
        });
      }
      _json(res, 200, {
        id,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: toolState.size ? "tool_use" : finishReason,
        stop_sequence: null,
        usage: {
          input_tokens: (usage && usage.input) || 0,
          output_tokens: (usage && usage.output) || 0,
          cache_read_input_tokens: (usage && usage.cached) || 0,
          cache_creation_input_tokens: (usage && usage.cacheWrite) || 0,
        },
      });
    },
    onError: (msg) => {
      const c = _classifyUpstreamError(msg);
      _json(
        res,
        c.status,
        {
          type: "error",
          error: {
            type: c.status === 429 ? "rate_limit_error" : "api_error",
            message: String(msg),
          },
        },
        c.retryAfter ? { "Retry-After": String(c.retryAfter) } : undefined,
      );
    },
  });
}

function _responsesBody(id, model, text, reasoning, toolState, usage, status) {
  const output = [];
  if (text || !toolState.size) {
    output.push({
      id: _genId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: text || "", annotations: [] }],
    });
  }
  for (const call of toolState.values()) {
    output.push({
      id: _genId("fc"),
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments || "{}",
    });
  }
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: status || "completed",
    model,
    output,
    output_text: text || "",
    reasoning: reasoning ? { summary: [{ type: "summary_text", text: reasoning }] } : undefined,
    usage: usage
      ? {
          input_tokens: usage.input || 0,
          output_tokens: usage.output || 0,
          total_tokens: (usage.input || 0) + (usage.output || 0),
          input_tokens_details: { cached_tokens: usage.cached || 0 },
        }
      : undefined,
  };
}

function _emitResponsesStream(res, model, gen) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const id = _genId("resp");
  const toolState = new Map();
  let text = "";
  let reasoning = "";
  let usage = null;
  let sequence = 0;
  let messageAdded = false;
  const send = (type, obj) =>
    res.write(
      "event: " +
        type +
        "\ndata: " +
        JSON.stringify(Object.assign({ type, sequence_number: sequence++ }, obj || {})) +
        "\n\n",
    );
  const ensureMessage = () => {
    if (messageAdded) return;
    messageAdded = true;
    send("response.output_item.added", {
      output_index: 0,
      item: {
        id: _genId("msg"),
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    });
    send("response.content_part.added", {
      item_id: id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };
  send("response.created", { response: _responsesBody(id, model, "", "", toolState, null, "in_progress") });
  send("response.in_progress", { response: _responsesBody(id, model, "", "", toolState, null, "in_progress") });
  gen({
    onText: (value) => {
      ensureMessage();
      text += value;
      send("response.output_text.delta", {
        item_id: id,
        output_index: 0,
        content_index: 0,
        delta: value,
      });
    },
    onThinking: (value) => {
      reasoning += value;
      send("response.reasoning_summary_text.delta", {
        output_index: 0,
        summary_index: 0,
        delta: value,
      });
    },
    onToolCalls: (calls) => {
      for (const call of calls || []) {
        const merged = _mergeToolCall(toolState, call, "append");
        send("response.output_item.added", {
          output_index: merged.index,
          item: {
            id: _genId("fc"),
            type: "function_call",
            status: "in_progress",
            call_id: merged.id,
            name: merged.function.name,
            arguments: "",
          },
        });
        if (call.function?.arguments)
          send("response.function_call_arguments.delta", {
            output_index: merged.index,
            call_id: merged.id,
            delta: call.function.arguments,
          });
      }
    },
    onToolCallStart: (call) => {
      const merged = _mergeToolCall(toolState, call, "append");
      send("response.output_item.added", {
        output_index: merged.index,
        item: {
          id: _genId("fc"),
          type: "function_call",
          status: "in_progress",
          call_id: merged.id,
          name: merged.function.name,
          arguments: "",
        },
      });
    },
    onToolCallDelta: (call) => {
      const merged = _mergeToolCall(toolState, call, "append");
      send("response.function_call_arguments.delta", {
        output_index: merged.index,
        call_id: merged.id,
        delta: call.partialJson || call.arguments || "",
      });
    },
    onToolCallComplete: (call) => _mergeToolCall(toolState, call, "replace"),
    onFinish: () => {},
    onUsage: (value) => (usage = _mergeUsage(usage, value)),
    onEnd: () => {
      if (messageAdded) {
        send("response.output_text.done", {
          item_id: id,
          output_index: 0,
          content_index: 0,
          text,
        });
      }
      for (const call of toolState.values()) {
        send("response.function_call_arguments.done", {
          output_index: call.index,
          call_id: call.id,
          arguments: call.function.arguments || "{}",
        });
        send("response.output_item.done", {
          output_index: call.index,
          item: {
            id: _genId("fc"),
            type: "function_call",
            status: "completed",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments || "{}",
          },
        });
      }
      send("response.completed", {
        response: _responsesBody(id, model, text, reasoning, toolState, usage, "completed"),
      });
      res.end();
    },
    onError: (message) => {
      const classified = _classifyUpstreamError(message);
      send("error", {
        error: {
          message: String(message),
          type: classified.type,
          code: classified.code,
        },
      });
      res.end();
    },
  });
}

function _emitResponsesUnary(res, model, gen) {
  const id = _genId("resp");
  let text = "";
  let reasoning = "";
  let usage = null;
  const toolState = new Map();
  gen({
    onText: (value) => (text += value),
    onThinking: (value) => (reasoning += value),
    onToolCalls: (calls) =>
      (calls || []).forEach((call) => _mergeToolCall(toolState, call, "append")),
    onToolCallStart: (call) => _mergeToolCall(toolState, call, "append"),
    onToolCallDelta: (call) => _mergeToolCall(toolState, call, "append"),
    onToolCallComplete: (call) => _mergeToolCall(toolState, call, "replace"),
    onFinish: () => {},
    onUsage: (value) => (usage = _mergeUsage(usage, value)),
    onEnd: () => _json(res, 200, _responsesBody(id, model, text, reasoning, toolState, usage)),
    onError: (message) => {
      const classified = _classifyUpstreamError(message);
      _json(res, classified.status, {
        error: {
          message: String(message),
          type: classified.type,
          code: classified.code,
        },
      });
    },
  });
}

function _geminiCandidate(model, text, toolState, finishReason) {
  const parts = [];
  if (text) parts.push({ text });
  for (const call of toolState.values()) {
    let args = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      args = { value: call.function.arguments || "" };
    }
    parts.push({ functionCall: { id: call.id, name: call.function.name, args } });
  }
  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: toolState.size
          ? "STOP"
          : finishReason === "length"
            ? "MAX_TOKENS"
            : finishReason === "content_filter"
              ? "SAFETY"
              : "STOP",
        index: 0,
      },
    ],
    modelVersion: model,
  };
}

function _emitGeminiStream(res, model, gen) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const toolState = new Map();
  let finishReason = "stop";
  let usage = null;
  const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
  gen({
    onText: (value) => send(_geminiCandidate(model, value, new Map(), "stop")),
    onThinking: (value) =>
      send({ candidates: [{ content: { role: "model", parts: [{ text: value, thought: true }] }, index: 0 }] }),
    onToolCalls: (calls) => {
      for (const call of calls || []) {
        _mergeToolCall(toolState, call, "append");
      }
    },
    onToolCallStart: (call) => _mergeToolCall(toolState, call, "append"),
    onToolCallDelta: (call) => _mergeToolCall(toolState, call, "append"),
    onToolCallComplete: (call) => {
      _mergeToolCall(toolState, call, "replace");
    },
    onFinish: (reason) => {
      if (reason) finishReason = reason;
    },
    onUsage: (value) => (usage = _mergeUsage(usage, value)),
    onEnd: () => {
      const finalChunk = _geminiCandidate(model, "", toolState, finishReason);
      if (usage)
        finalChunk.usageMetadata = {
          promptTokenCount: usage.input || 0,
          candidatesTokenCount: usage.output || 0,
          totalTokenCount: (usage.input || 0) + (usage.output || 0),
          cachedContentTokenCount: usage.cached || 0,
        };
      send(finalChunk);
      res.end();
    },
    onError: (message) => {
      send({ error: { code: 502, message: String(message), status: "UNAVAILABLE" } });
      res.end();
    },
  });
}

function _emitGeminiUnary(res, model, gen) {
  let text = "";
  let finishReason = "stop";
  let usage = null;
  const toolState = new Map();
  gen({
    onText: (value) => (text += value),
    onThinking: () => {},
    onToolCalls: (calls) =>
      (calls || []).forEach((call) => _mergeToolCall(toolState, call, "append")),
    onToolCallStart: (call) => _mergeToolCall(toolState, call, "append"),
    onToolCallDelta: (call) => _mergeToolCall(toolState, call, "append"),
    onToolCallComplete: (call) => _mergeToolCall(toolState, call, "replace"),
    onFinish: (reason) => {
      if (reason) finishReason = reason;
    },
    onUsage: (value) => (usage = _mergeUsage(usage, value)),
    onEnd: () => {
      const body = _geminiCandidate(model, text, toolState, finishReason);
      if (usage)
        body.usageMetadata = {
          promptTokenCount: usage.input || 0,
          candidatesTokenCount: usage.output || 0,
          totalTokenCount: (usage.input || 0) + (usage.output || 0),
          cachedContentTokenCount: usage.cached || 0,
        };
      _json(res, 200, body);
    },
    onError: (message) =>
      _json(res, 502, { error: { code: 502, message: String(message), status: "UNAVAILABLE" } }),
  });
}

function _json(res, code, obj, extraHeaders) {
  const s = JSON.stringify(obj);
  res.writeHead(
    code,
    Object.assign(
      {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(s)),
      },
      extraHeaders || {},
    ),
  );
  res.end(s);
}

// 上游错误归类: 把官方上游错误如实映射为正确的 HTTP 语义,
// 杜绝「速率限制/配额耗尽」被笼统当成 502(网关错误)误导客户端重试。
//   速率限制(官方按模型限频, 形如 "Reached message rate limit ... Resets in: 1h30m0s")
//     → 429 Too Many Requests + Retry-After(秒); 客户端据此退避而非狂重试。
//   配额耗尽 → 429 insufficient_quota。
//   其余上游故障 → 502 upstream_error。
function _classifyUpstreamError(msg) {
  const s = String(msg || "");
  const rateLimited = /rate limit|Resets in|too many requests|\b429\b/i.test(s);
  const quota = /quota|exhaust|governor|precondition|insufficient|Authentication Fails/i.test(
    s,
  );
  if (rateLimited || quota) {
    let retryAfter = 0;
    const m = s.match(/Resets in:\s*(?:(\d+)\s*h)?(?:(\d+)\s*m)?(?:(\d+)\s*s)?/i);
    if (m)
      retryAfter =
        parseInt(m[1] || 0, 10) * 3600 +
        parseInt(m[2] || 0, 10) * 60 +
        parseInt(m[3] || 0, 10);
    return {
      status: 429,
      type: "rate_limit_error",
      code: rateLimited ? "rate_limit_exceeded" : "insufficient_quota",
      retryAfter,
    };
  }
  // 会话失活 / 客户端版本过旧: 非瞬时网关故障(502 会诱导客户端对同一陈旧帧狂重试),
  //   而是「先决条件缺失」——需重采新鲜捕获帧或升级编辑器。以 424 Failed Dependency +
  //   明确 code=stale_session 如实表达, 客户端据此停重试并按指引重采, 而非盲目退避。
  const stale = /please update your editor|Cascade session|session (?:has )?expired|invalid session|失活|重采|版本过旧/i.test(
    s,
  );
  if (stale) {
    return { status: 424, type: "upstream_error", code: "stale_session", retryAfter: 0 };
  }
  return { status: 502, type: "upstream_error", code: "upstream_error", retryAfter: 0 };
}

function _html(res, code, html) {
  const s = String(html);
  res.writeHead(code, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(s)),
    "Cache-Control": "no-cache",
  });
  res.end(s);
}

// ── 网页对话台 (web chat console) · 同源单页 ──────────────────────────────
//   反者道之动: 把「调用一切反代模型 + 管理(档位热切) + AI 测试验证」收束为一张
//   自包含网页, 与 /v1 同源。本机直开或经内网穿透远程任意环境浏览器皆可达 ——
//   页面静态零鉴权, 真正的模型调用仍由 /v1 的 Bearer key 把关。
let _consoleHtmlCache = null;
function consoleHtml() {
  if (_consoleHtmlCache != null) return _consoleHtmlCache;
  try {
    _consoleHtmlCache = fs.readFileSync(
      path.join(__dirname, "revproxy_console.html"),
      "utf8",
    );
  } catch (e) {
    _consoleHtmlCache =
      '<!DOCTYPE html><meta charset="utf-8"><title>dao 反代对话台</title>' +
      '<body style="font:14px sans-serif;background:#0e1116;color:#d6dde7;padding:24px">' +
      "网页对话台资源缺失 (revproxy_console.html 未随插件打包)。</body>";
  }
  return _consoleHtmlCache;
}

// ── 入站安全: 请求体限制、端点限流、脱敏元数据审计 ────────────────
const _REQUEST_GUARD_DEFAULTS = Object.freeze({
  maxBodyBytes: 8 * 1024 * 1024,
  windowMs: 60 * 1000,
  maxRequests: 120,
  auditLimit: 500,
});
const _requestRateBuckets = new Map();
const _requestAudit = [];

function _requestGuardConfig(cfg) {
  const guard = (cfg && cfg.requestGuard) || {};
  return {
    maxBodyBytes: Math.max(64 * 1024, Number(guard.maxBodyBytes) || _REQUEST_GUARD_DEFAULTS.maxBodyBytes),
    windowMs: Math.max(1000, Number(guard.windowMs) || _REQUEST_GUARD_DEFAULTS.windowMs),
    maxRequests: Math.max(1, Number(guard.maxRequests) || _REQUEST_GUARD_DEFAULTS.maxRequests),
  };
}

function _requestClientId(req, cfg) {
  // 转发头只能在部署者显式信任前置代理时使用；默认以实际 socket 地址限流，防伪造绕过。
  const trustProxy = !!(cfg && cfg.requestGuard && cfg.requestGuard.trustProxy === true);
  const forwarded = trustProxy
    ? String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim()
    : "";
  return forwarded || (req.socket && req.socket.remoteAddress) || "local";
}

function _requestRateAllowed(req, endpoint, cfg) {
  const guard = _requestGuardConfig(cfg);
  const now = Date.now();
  const key = `${_requestClientId(req, cfg)}|${endpoint}`;
  const current = _requestRateBuckets.get(key);
  const bucket = !current || now - current.startedAt >= guard.windowMs
    ? { startedAt: now, count: 0 }
    : current;
  bucket.count++;
  _requestRateBuckets.set(key, bucket);
  if (_requestRateBuckets.size > 2048) {
    for (const [bucketKey, value] of _requestRateBuckets) {
      if (now - value.startedAt >= guard.windowMs) _requestRateBuckets.delete(bucketKey);
    }
  }
  return { ok: bucket.count <= guard.maxRequests, retryAfterMs: Math.max(0, guard.windowMs - (now - bucket.startedAt)) };
}

function requestGuardStatus(cfg, includeAudit = false) {
  return {
    config: _requestGuardConfig(cfg),
    activeBuckets: _requestRateBuckets.size,
    recentAudit: includeAudit ? _requestAudit.slice(-50) : undefined,
  };
}

function _auditRequest(req, endpoint, status, bodyBytes, model) {
  _requestAudit.push({
    at: new Date().toISOString(), method: req.method, endpoint, status,
    client: _requestClientId(req), bodyBytes: Number(bodyBytes) || 0,
    model: typeof model === "string" ? model.slice(0, 160) : undefined,
  });
  while (_requestAudit.length > _REQUEST_GUARD_DEFAULTS.auditLimit) _requestAudit.shift();
}

function _readBody(req, opts = {}) {
  const maxBytes = Math.max(64 * 1024, Number(opts.maxBytes) || _REQUEST_GUARD_DEFAULTS.maxBodyBytes);
  const declared = Number(req.headers && req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error("request body too large"); error.code = "BODY_TOO_LARGE";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let rejected = false;
    req.on("data", (c) => {
      bytes += c.length;
      if (bytes > maxBytes && !rejected) {
        rejected = true;
        const error = new Error("request body too large"); error.code = "BODY_TOO_LARGE";
        reject(error);
        req.resume();
        return;
      }
      if (!rejected) chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        const s = Buffer.concat(chunks).toString("utf8");
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// 单目标分派: 把一个 target 的上游流适配到 sink。
function _dispatch(target, norm, deps, sink) {
  if (target.builtin) {
    // builtin-stub: 固定返回 · 验证通路
    sink.onText &&
      sink.onText("道可道也 非恒道也 · 模型反代传输层得一 · stub 正常");
    sink.onUsage && sink.onUsage({ input: 10, output: 20 });
    sink.onEnd && sink.onEnd();
    return;
  }
  if (target.official) {
    // 官方直通: 复用宿主 source.js 官方推理链(捕帧复用 GetChatMessage)
    if (!deps.officialChat) {
      sink.onError &&
        sink.onError(
          "官方直通未就绪 · 需宿主提供 officialChat(预热一次官方对话以捕获帧)",
        );
      return;
    }
    Promise.resolve()
      .then(() => deps.officialChat(target, norm, sink))
      .then((r) => {
        // officialChat 自行调 sink.onText/onEnd; 若返回配额态则同步着色
        if (r && r.quota) setPremiumQuota(r.quota);
      })
      .catch((e) => {
        const msg = String((e && e.message) || e);
        if (/quota|exhaust|配额|governor|Authentication Fails/i.test(msg))
          setPremiumQuota("exhausted");
        sink.onError && sink.onError(msg);
      });
    return;
  }
  callUpstream(target, norm, deps, {
    onOpen: (status) => sink.onOpen && sink.onOpen(status),
    onDelta: (d) => {
      if (d.content && sink.onText) sink.onText(d.content);
      if (d.thinking && sink.onThinking) sink.onThinking(d.thinking);
      if (d.toolCalls && sink.onToolCalls) sink.onToolCalls(d.toolCalls);
      if (d.toolCallStart && sink.onToolCallStart)
        sink.onToolCallStart(d.toolCallStart);
      if (d.toolCallDelta && sink.onToolCallDelta)
        sink.onToolCallDelta(d.toolCallDelta);
      if (d.toolCallComplete && sink.onToolCallComplete)
        sink.onToolCallComplete(d.toolCallComplete);
      if (d.finishReason && sink.onFinish) sink.onFinish(d.finishReason);
      if (d.usage && sink.onUsage) sink.onUsage(d.usage);
    },
    onDone: () => sink.onEnd && sink.onEnd(),
    onError: (e, status) =>
      sink.onError && sink.onError(String((e && e.message) || e), status),
  });
}

function _cacheFingerprint(value) {
  const source = String(value || "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function _observationErrorCategory(message) {
  const value = String(message || "");
  if (/timeout|timed out/i.test(value)) return "timeout";
  if (/401|auth|credential|api key/i.test(value)) return "authentication";
  if (/403|forbidden|permission/i.test(value)) return "permission";
  if (/429|rate.?limit|too many/i.test(value)) return "rate-limit";
  if (/network|socket|connect|dns/i.test(value)) return "network";
  return "upstream";
}

function _observationId(prefix, requestId, index) {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${String(requestId).slice(-8)}_${index}_${suffix}`;
}

function _attemptStatus(status) {
  const value = Number(status);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 0;
}

function _boundedAttempts(attempts) {
  return (Array.isArray(attempts) ? attempts : []).slice(-8).map((attempt) => ({
    ...attempt,
    provider: String(attempt.provider || "").slice(0, 100),
    model: String(attempt.model || "").slice(0, 100),
    outcome: ["committed", "failed", "discarded"].includes(attempt.outcome)
      ? attempt.outcome
      : "discarded",
    errorCategory: String(attempt.errorCategory || "").slice(0, 40),
    retryReason: String(attempt.retryReason || "").slice(0, 80),
  }));
}

// 把统一上游 delta 适配到客户端发射器的 generator。
// candidates: [主路, 备路?] — 主路遇限流/配额且「未出首字节」时自动切备路(双路互补)。
function _bridge(candidates, norm, deps, observation) {
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(
    Boolean,
  );
  const log = (deps && deps.log) || (() => {});
  const requestObservation = observation || {
    source: "external",
    startedAt: Date.now(),
  };
  return (sink) => {
    const requestId = _observationId("req", requestObservation.startedAt, 0);
    const attempts = [];
    let committedAttemptId = "";
    let usageRecorded = false;
    let attemptCount = 0;
    let firstAttemptStartedAt = 0;
    let lastAttemptStartedAt = 0;
    let lastAttemptHeaderAt = 0;
    let committedAttemptStartedAt = 0;
    let committedHeaderAt = 0;
    let firstVisibleAt = 0;
    let firstSignalKind = "none";
    let committedUsage = null;
    let textBytes = 0;
    const responseTools = new Set();

    const beginAttempt = (target, index, retryReason) => {
      const attempt = {
        requestId,
        attemptId: _observationId("attempt", requestId, index),
        attemptIndex: index,
        provider: target.provName || target.provider || "upstream",
        model: target.upstreamModel || "?",
        startedAt: Date.now(),
        endedAt: null,
        durationMs: null,
        status: null,
        outcome: "discarded",
        errorCategory: "",
        retryReason: retryReason || "",
        usageObserved: false,
        input: 0,
        output: 0,
        cached: 0,
        cacheWrite: 0,
      };
      attempts.push(attempt);
      if (attempts.length > 8) attempts.shift();
      return attempt;
    };
    const finishAttempt = (attempt, outcome, status, message) => {
      if (!attempt || attempt.endedAt != null) return;
      attempt.endedAt = Date.now();
      attempt.durationMs = Math.max(0, attempt.endedAt - attempt.startedAt);
      if (status !== undefined) attempt.status = _attemptStatus(status);
      attempt.outcome = outcome;
      if (message) attempt.errorCategory = _observationErrorCategory(message);
    };

    const observeVisible = (kind) => {
      if (!firstVisibleAt) {
        firstVisibleAt = Date.now();
        firstSignalKind = kind === "tool" ? "tool" : "text";
      }
    };
    const toolKey = (call) => String(
      call && (call.id || call.call_id || call.name) ||
      "tool-" + responseTools.size,
    );
    const record = (target, success, message) => {
      if (usageRecorded || !target || !target.provName || target.builtin) return;
      usageRecorded = true;
      const terminalAt = Date.now();
      const ttftObserved = firstVisibleAt > 0;
      const daoDispatchMs = firstAttemptStartedAt
        ? Math.max(0, firstAttemptStartedAt - requestObservation.startedAt)
        : 0;
      const attemptStartedAt = success
        ? committedAttemptStartedAt
        : lastAttemptStartedAt;
      const headerAt = success ? committedHeaderAt : lastAttemptHeaderAt;
      const upstreamHeaderMs = headerAt && attemptStartedAt
        ? Math.max(0, headerAt - attemptStartedAt)
        : null;
      const upstreamSemanticMs = ttftObserved && committedAttemptStartedAt
        ? Math.max(0, firstVisibleAt - committedAttemptStartedAt)
        : null;
      const ttftMs = ttftObserved
        ? Math.max(0, firstVisibleAt - requestObservation.startedAt)
        : null;
      const durationMs = Math.max(0, terminalAt - requestObservation.startedAt);
      const retryOverheadMs = success && ttftObserved && upstreamSemanticMs != null
        ? Math.max(0, ttftMs - daoDispatchMs - upstreamSemanticMs)
        : lastAttemptStartedAt
          ? Math.max(0, durationMs - daoDispatchMs - (terminalAt - lastAttemptStartedAt))
          : 0;
      if (deps.recordUsage) {
        try {
          deps.recordUsage(
            target.provName,
            target.upstreamModel,
            success ? (committedUsage || {}) : {},
            {
              ...requestObservation,
              requestId,
              committedAttemptId,
              attempts: _boundedAttempts(attempts),
              ttftMs,
              ttftObserved,
              daoDispatchMs,
              upstreamHeaderMs,
              upstreamSemanticMs,
              retryOverheadMs,
              firstSignalKind,
              durationMs,
              attemptCount,
              responseToolCount: responseTools.size,
              textBytes,
              success,
              usageObserved: success && !!committedUsage,
              errorCategory: success ? "" : _observationErrorCategory(message),
            },
          );
        } catch (_) {}
      }
      if (
        success &&
        requestObservation.source === "codex" &&
        requestObservation.cacheKeyHash &&
        deps.markCodexObserved
      ) {
        try {
          deps.markCodexObserved({ at: Date.now() });
        } catch (_) {}
      }
    };
    if (!list.length) {
      sink.onError && sink.onError("无可用反代目标");
      return;
    }
    const run = (i, emptyRetry, retryReason) => {
      attemptCount += 1;
      const attemptStartedAt = Date.now();
      let attemptHeaderAt = 0;
      if (!firstAttemptStartedAt) firstAttemptStartedAt = attemptStartedAt;
      lastAttemptStartedAt = attemptStartedAt;
      lastAttemptHeaderAt = 0;
      const target = list[i];
      const attempt = beginAttempt(target, attemptCount, retryReason);
      const hasNext = i + 1 < list.length;
      let committed = false;
      let pendingText = "";
      let pendingReasoning = "";
      let pendingFinish;
      let pendingUsage;
      let currentAttemptUsage = null;
      const targetLabel =
        (target && (target.provName || target.provider || target.upstreamModel)) ||
        "upstream";
      const flushPending = () => {
        if (committed) return;
        committed = true;
        committedAttemptStartedAt = attemptStartedAt;
        committedHeaderAt = attemptHeaderAt;
        committedUsage = currentAttemptUsage;
        if (pendingReasoning && sink.onThinking) sink.onThinking(pendingReasoning);
        if (pendingText && sink.onText) sink.onText(pendingText);
        if (pendingFinish !== undefined && sink.onFinish) sink.onFinish(pendingFinish);
        if (pendingUsage && sink.onUsage) sink.onUsage(pendingUsage);
        pendingReasoning = "";
        pendingText = "";
        pendingFinish = undefined;
        pendingUsage = undefined;
      };
      // Reasoning is buffered until visible text or a tool call arrives. Codex does
      // not render reasoning-only responses, so committing them would look like a
      // successful turn with no output and would also prevent channel failover.
      _dispatch(target, norm, deps, {
        onOpen: (status) => {
          if (!attemptHeaderAt) attemptHeaderAt = Date.now();
          lastAttemptHeaderAt = attemptHeaderAt;
          attempt.status = _attemptStatus(status) || 200;
          sink.onOpen && sink.onOpen();
        },
        onText: (t) => {
          const value = String(t || "");
          if (value) textBytes += Buffer.byteLength(value, "utf8");
          if (committed) {
            observeVisible("text");
            sink.onText && sink.onText(value);
            return;
          }
          pendingText += value;
          if (/\S/.test(pendingText)) {
            observeVisible("text");
            flushPending();
          }
        },
        onThinking: (t) => {
          const value = String(t || "");
          if (committed) sink.onThinking && sink.onThinking(value);
          else pendingReasoning += value;
        },
        onToolCalls: (calls) => {
          if (!Array.isArray(calls) || !calls.length) return;
          observeVisible("tool");
          for (const call of calls) responseTools.add(toolKey(call));
          flushPending();
          sink.onToolCalls && sink.onToolCalls(calls);
        },
        onToolCallStart: (call) => {
          observeVisible("tool");
          responseTools.add(toolKey(call));
          flushPending();
          sink.onToolCallStart && sink.onToolCallStart(call);
        },
        onToolCallDelta: (call) => {
          observeVisible("tool");
          responseTools.add(toolKey(call));
          flushPending();
          sink.onToolCallDelta && sink.onToolCallDelta(call);
        },
        onToolCallComplete: (call) => {
          observeVisible("tool");
          responseTools.add(toolKey(call));
          flushPending();
          sink.onToolCallComplete && sink.onToolCallComplete(call);
        },
        onFinish: (f) => {
          if (committed) sink.onFinish && sink.onFinish(f);
          else pendingFinish = f;
        },
        onUsage: (u) => {
          if (u) {
            currentAttemptUsage = _mergeUsage(currentAttemptUsage, u);
            attempt.usageObserved = true;
            for (const field of ["input", "output", "cached", "cacheWrite"]) {
              attempt[field] = Number(currentAttemptUsage[field]) || 0;
            }
            if (committed) committedUsage = currentAttemptUsage;
          }
          if (committed) sink.onUsage && sink.onUsage(_mergeUsage(null, u));
          else pendingUsage = _mergeUsage(pendingUsage, u);
        },
        onEnd: () => {
          if (committed) {
            finishAttempt(attempt, "committed", attempt.status || 200);
            committedAttemptId = attempt.attemptId;
            record(target, true, "");
            sink.onEnd && sink.onEnd();
            return;
          }
          attempt.retryReason = "empty-response";
          if ((emptyRetry || 0) < 1) {
            finishAttempt(attempt, "discarded", attempt.status || 200);
            log(
              "[revproxy] empty/reasoning-only response → transparent retry provider=" +
                targetLabel,
            );
            run(i, (emptyRetry || 0) + 1, "empty-response");
            return;
          }
          if (hasNext) {
            finishAttempt(attempt, "discarded", attempt.status || 200);
            log(
              "[revproxy] empty response after retry → next configured channel provider=" +
                targetLabel,
            );
            run(i + 1, 0, "empty-response");
            return;
          }
          const message =
            "Upstream returned no visible text or tool calls after retry on all configured channels";
          finishAttempt(attempt, "failed", attempt.status || 200, message);
          record(target, false, message);
          sink.onError && sink.onError(message);
        },
        onError: (e, status) => {
          const msg = String((e && e.message) || e);
          finishAttempt(attempt, "failed", status == null ? 0 : status, msg);
          if (!committed && hasNext) {
            log(
              "[revproxy] 配置渠道失败 → 切下一优先级 (" +
                msg.slice(0, 80) +
                ")",
            );
            run(i + 1, 0, "upstream-error");
            return;
          }
          record(target, false, msg);
          sink.onError && sink.onError(msg);
        },
      });
    };
    run(0, 0);
  };
}

function _readCodexModelCatalogFiles(codexHome, configPath) {
  const configured = [];
  try {
    const configText = fs.readFileSync(
      configPath || path.join(codexHome, "config.toml"),
      "utf8",
    );
    const match = configText.match(/^\s*model_catalog_json\s*=\s*"([^"]+)"/m);
    if (match && match[1]) configured.push(match[1]);
  } catch (_) {}
  const candidates = [
    ...configured,
    "dao-codex-model-catalog.json",
    "cockpit-local-access-model-catalog.json",
    "models_cache.json",
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    const file = path.isAbsolute(candidate) ? candidate : path.join(codexHome, candidate);
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const models = Array.isArray(parsed && parsed.models) ? parsed.models : [];
      if (models.length) return models;
    } catch (_) {}
  }
  return [];
}

// Throttle disk catalog pin so classic-forced stays durable without writing every request.
let _lastClassicCatalogPinAt = 0;
const CLASSIC_CATALOG_PIN_MS = 15_000;

function _maybePinClassicCatalogs(hot) {
  const surface = String((hot && hot.toolSurface) || "classic-forced")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (surface === "catalog-passthrough") return;
  const now = Date.now();
  if (now - _lastClassicCatalogPinAt < CLASSIC_CATALOG_PIN_MS) return;
  _lastClassicCatalogPinAt = now;
  try {
    // Lazy require keeps revproxy load free of circular init issues.
    const codexHot = require(path.join(__dirname, "codex_hot_route.js"));
    if (codexHot && typeof codexHot.ensureDirectToolCatalogs === "function") {
      codexHot.ensureDirectToolCatalogs({ toolSurface: "classic-forced" });
    }
  } catch (_) {}
}

function _codexHotModels(deps) {
  const hot = deps && deps.getCodexHotRoute && deps.getCodexHotRoute();
  if (!hot || !hot.enabled) return [];
  const codexSlug = String(hot.codexModel || hot.model || "").trim();
  const upstreamSlug = String(hot.model || "").trim();
  if (!codexSlug) return [];
  // Durable pin while hot route serves models (host-off + only must not stick).
  _maybePinClassicCatalogs(hot);
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const cached = _readCodexModelCatalogFiles(
    codexHome,
    path.join(codexHome, "config.toml"),
  );
  const source =
    cached.find((model) => model && model.slug === codexSlug) ||
    cached.find((model) => model && model.slug === upstreamSlug) ||
    cached[0];
  // With no native catalog entry, an empty valid catalog lets Codex use its
  // own bundled fallback metadata instead of injecting a reduced prompt/tool contract.
  // toolSurface (codex-hot-route.json):
  //   classic-forced (default): force direct shell/patch when catalog is code_mode_*
  //     so local host-off setups keep tools. Does NOT rewrite prompts/tool schemas.
  //   catalog-passthrough: return catalog tool_mode as-is (only safe if code_mode_host on).
  if (!source) return [];
  const model = JSON.parse(JSON.stringify(source));
  model.slug = codexSlug;
  model.visibility = "list";
  model.supported_in_api = true;
  model.priority = 0;

  const toolSurface = String(hot.toolSurface || "classic-forced")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (toolSurface !== "catalog-passthrough") {
    model.shell_type = model.shell_type || "shell_command";
    model.apply_patch_tool_type = model.apply_patch_tool_type || "freeform";
    if (model.supports_parallel_tool_calls == null) {
      model.supports_parallel_tool_calls = true;
    }
    if (
      model.tool_mode === "code_mode_only" ||
      model.tool_mode === "code_mode" ||
      !model.tool_mode
    ) {
      model.tool_mode = "direct";
    }
    if (model.use_responses_lite === true) {
      model.use_responses_lite = false;
    }
  }

  const effort = String(hot.reasoningLevel || "").trim().toLowerCase();
  if (effort && effort !== "off") {
    model.default_reasoning_level = effort;
    if (!Array.isArray(model.supported_reasoning_levels)) {
      model.supported_reasoning_levels = [];
    }
    if (!model.supported_reasoning_levels.some((entry) => entry && entry.effort === effort)) {
      model.supported_reasoning_levels.push({
        effort,
        description: "Configured reasoning effort for the active Codex hot route",
      });
    }
  }
  return [model];
}

// ── 主入口: 由 source.js 在 /v1/* 与 /origin/revproxy/* 委派 ──────────────────
// 返回 true 表示已处理。deps: { getEaConfig, getAvailableModels, resolveRoute,
//   invertSP, getProxyAgent, log, version }
async function handle(req, res, u, deps) {
  const p = u.pathname;
  if (
    !p.startsWith("/v1/") &&
    !p.startsWith("/v1beta/") &&
    !p.startsWith("/codex-hot/v1/") &&
    !p.startsWith("/origin/revproxy")
  )
    return false;

  const cfg = loadConfig();
  deps = deps || {};
  deps.cfg = cfg;
  const log = deps.log || (() => {});

  // ── 网页对话台 (远程任意环境浏览器直开 · 同源单页·零鉴权) ──────────────
  if (
    req.method === "GET" &&
    (p === "/origin/revproxy/console" ||
      p === "/origin/revproxy/chat" ||
      p === "/origin/revproxy" ||
      p === "/origin/revproxy/")
  ) {
    _html(res, 200, consoleHtml());
    return true;
  }

  // ── 控制面 (webview 用·本机) ──────────────────────────────────
  if (p === "/origin/revproxy/status" && req.method === "GET") {
    const models = listModels(deps);
    _json(res, 200, {
      ok: true,
      version: deps.version || "",
      enabled: cfg.enabled,
      applyInvert: cfg.applyInvert,
      isolatePrompt: cfg.isolatePrompt !== false,
      disabledModels: cfg.disabledModels || [],
      exposeLan: cfg.exposeLan,
      dualPath: cfg.dualPath !== false,
      hasKey: !!cfg.apiKey,
      apiKey: _isLocal(req) ? cfg.apiKey : undefined,
      port: deps.port || 0,
      endpoint: deps.port ? "http://127.0.0.1:" + deps.port + "/v1" : "",
      supportedProtocols: [
        "openai-chat",
        "openai-responses",
        "anthropic",
        "gemini",
      ],
      endpoints: deps.port
        ? {
            models: "http://127.0.0.1:" + deps.port + "/v1/models",
            openaiChat:
              "http://127.0.0.1:" + deps.port + "/v1/chat/completions",
            openaiResponses:
              "http://127.0.0.1:" + deps.port + "/v1/responses",
            anthropic: "http://127.0.0.1:" + deps.port + "/v1/messages",
            gemini:
              "http://127.0.0.1:" +
              deps.port +
              "/v1beta/models/{model}:generateContent",
            geminiStream:
              "http://127.0.0.1:" +
              deps.port +
              "/v1beta/models/{model}:streamGenerateContent?alt=sse",
          }
        : {},
      premiumQuota:
        (deps && typeof deps.premiumQuota === "string"
          ? deps.premiumQuota
          : null) || _premiumQuota,
      model_count: models.length,
      stats: modelStats(models),
      models,
      families: familySummary(deps, models),
      tiers: cfg.tiers || {},
      requestGuard: requestGuardStatus(cfg, _isLocal(req)),
      outboundRedact: {
        enabled: !!(cfg.outboundRedact && cfg.outboundRedact.enabled),
        mode: (cfg.outboundRedact && cfg.outboundRedact.mode) || "redact",
      },
      exactCache: {
        enabled: !!(cfg.exactCache && cfg.exactCache.enabled),
        ttlMs: (cfg.exactCache && cfg.exactCache.ttlMs) || 300000,
        maxEntries: (cfg.exactCache && cfg.exactCache.maxEntries) || 500,
        stats:
          _exactCache && typeof _exactCache.snapshot === "function"
            ? _exactCache.snapshot()
            : null,
      },
      semanticCache: {
        enabled: !!(cfg.semanticCache && cfg.semanticCache.enabled),
        threshold: (cfg.semanticCache && cfg.semanticCache.threshold) || 0.95,
        configured: !!(
          cfg.semanticCache &&
          cfg.semanticCache.embed &&
          cfg.semanticCache.embed.baseUrl &&
          cfg.semanticCache.embed.model
        ),
        embedModel: (cfg.semanticCache && cfg.semanticCache.embed && cfg.semanticCache.embed.model) || "",
        stats:
          _semanticCache && typeof _semanticCache.snapshot === "function"
            ? _semanticCache.snapshot()
            : null,
      },
    });
    return true;
  }
  // 档位热切换: 设某家族当前活跃档 (热生效·无需重启) ──
  if (p === "/origin/revproxy/tier" && req.method === "POST") {
    // 远程管理: 本机直放行; 远程需持有效 Bearer key (与 /v1 同一把关)。
    if (!_isLocal(req) && !_authOk(req, cfg)) {
      _json(res, 403, {
        ok: false,
        error: "需本机或有效 Bearer key (远程管理)",
      });
      return true;
    }
    let body = {};
    try {
      body = await _readBody(req);
    } catch (_) {}
    const fu = body.familyUid;
    const mu = body.modelUid;
    if (!fu || !mu) {
      _json(res, 400, { ok: false, error: "familyUid + modelUid required" });
      return true;
    }
    const next = Object.assign(loadConfig(), {});
    next.tiers = Object.assign({}, next.tiers || {});
    next.tiers[fu] = mu;
    saveConfig(next);
    _json(res, 200, { ok: true, tiers: next.tiers });
    return true;
  }
  // 模型外接选择: 原子切换某(些)模型是否对外反代 (热生效·无需重启) ──
  //   body: {modelUid|modelUids:[...], exposed:bool} 精确开关 ·
  //         {setAll:"on"|"off"} 批量全选/全不选(off 时排除当前全部枚举模型)。
  if (p === "/origin/revproxy/models" && req.method === "POST") {
    if (!_isLocal(req) && !_authOk(req, cfg)) {
      _json(res, 403, { ok: false, error: "需本机或有效 Bearer key (远程管理)" });
      return true;
    }
    let body = {};
    try {
      body = await _readBody(req);
    } catch (_) {}
    const next = Object.assign(loadConfig(), {});
    let dis = Array.isArray(next.disabledModels)
      ? next.disabledModels.slice()
      : [];
    const disSet = new Set(dis);
    if (body.setAll === "on") {
      disSet.clear(); // 全选反代 · 万物并育
    } else if (body.setAll === "off") {
      for (const m of listModels(deps)) disSet.add(m.id); // 全不外接
    } else {
      const ids = Array.isArray(body.modelUids)
        ? body.modelUids
        : body.modelUid
          ? [body.modelUid]
          : [];
      const exposed = body.exposed !== false; // 缺省视为开启外接
      for (const id of ids) {
        if (!id || typeof id !== "string") continue;
        if (exposed) disSet.delete(id);
        else disSet.add(id);
      }
    }
    next.disabledModels = Array.from(disSet).slice(0, 2000);
    saveConfig(next);
    _json(res, 200, {
      ok: true,
      disabledModels: next.disabledModels,
      stats: modelStats(listModels(Object.assign({}, deps, { cfg: next }))),
    });
    return true;
  }
  if (p === "/origin/revproxy/config" && req.method === "POST") {
    if (!_isLocal(req)) {
      _json(res, 403, { ok: false, error: "localhost only" });
      return true;
    }
    let body = {};
    try {
      body = await _readBody(req);
    } catch (_) {}
    const next = Object.assign(loadConfig(), {});
    if (typeof body.enabled === "boolean") next.enabled = body.enabled;
    if (typeof body.applyInvert === "boolean")
      next.applyInvert = body.applyInvert;
    if (typeof body.isolatePrompt === "boolean")
      next.isolatePrompt = body.isolatePrompt;
    if (Array.isArray(body.disabledModels))
      next.disabledModels = body.disabledModels
        .filter((x) => typeof x === "string" && x)
        .slice(0, 2000);
    if (typeof body.exposeLan === "boolean") next.exposeLan = body.exposeLan;
    if (typeof body.defaultMaxTokens === "number")
      next.defaultMaxTokens = body.defaultMaxTokens;
    if (typeof body.dualPath === "boolean") next.dualPath = body.dualPath;
    if (body.outboundRedact && typeof body.outboundRedact === "object") {
      const cur = next.outboundRedact || {};
      const inbound = body.outboundRedact;
      next.outboundRedact = {
        ...cur,
        ...(typeof inbound.enabled === "boolean" ? { enabled: inbound.enabled } : {}),
        ...(typeof inbound.mode === "string" &&
        ["monitor", "redact", "block"].includes(inbound.mode)
          ? { mode: inbound.mode }
          : {}),
        ...(Array.isArray(inbound.enableRules) ? { enableRules: inbound.enableRules } : {}),
        ...(Array.isArray(inbound.disableRules) ? { disableRules: inbound.disableRules } : {}),
        ...(Array.isArray(inbound.customRules) ? { customRules: inbound.customRules } : {}),
      };
    }
    if (body.exactCache && typeof body.exactCache === "object") {
      const cur = next.exactCache || {};
      const inbound = body.exactCache;
      next.exactCache = {
        ...cur,
        ...(typeof inbound.enabled === "boolean" ? { enabled: inbound.enabled } : {}),
        ...(typeof inbound.ttlMs === "number" && inbound.ttlMs > 0
          ? { ttlMs: inbound.ttlMs }
          : {}),
        ...(typeof inbound.maxEntries === "number" && inbound.maxEntries > 0
          ? { maxEntries: inbound.maxEntries }
          : {}),
        ...(typeof inbound.cacheTools === "boolean"
          ? { cacheTools: inbound.cacheTools }
          : {}),
      };
    }
    if (body.semanticCache && typeof body.semanticCache === "object") {
      const cur = next.semanticCache || {};
      const inbound = body.semanticCache;
      const merged = { ...cur };
      if (typeof inbound.enabled === "boolean") merged.enabled = inbound.enabled;
      if (typeof inbound.threshold === "number" && inbound.threshold >= 0 && inbound.threshold <= 1)
        merged.threshold = inbound.threshold;
      if (typeof inbound.ttlMs === "number" && inbound.ttlMs > 0) merged.ttlMs = inbound.ttlMs;
      if (typeof inbound.maxEntries === "number" && inbound.maxEntries > 0)
        merged.maxEntries = inbound.maxEntries;
      if (inbound.embed && typeof inbound.embed === "object") {
        const curEmbed = cur.embed || {};
        merged.embed = {
          ...curEmbed,
          ...(typeof inbound.embed.baseUrl === "string" ? { baseUrl: inbound.embed.baseUrl } : {}),
          ...(typeof inbound.embed.model === "string" ? { model: inbound.embed.model } : {}),
          ...(typeof inbound.embed.apiKey === "string" ? { apiKey: inbound.embed.apiKey } : {}),
        };
      }
      next.semanticCache = merged;
    }
    if (body.tiers && typeof body.tiers === "object")
      next.tiers = Object.assign({}, next.tiers || {}, body.tiers);
    if (body.regenerateKey === true)
      next.apiKey = "dao-local-" + crypto.randomBytes(12).toString("hex");
    else if (typeof body.apiKey === "string") next.apiKey = body.apiKey;
    saveConfig(next);
    _json(res, 200, { ok: true, config: next });
    return true;
  }

  // ── 数据面 (标准 OpenAI / Anthropic) ──────────────────────────
  if (!cfg.enabled) {
    _json(res, 503, {
      error: {
        message: "模型反代未启用 · 请在「模型反代」面板开启",
        type: "revproxy_disabled",
      },
    });
    return true;
  }
  if (!_authOk(req, cfg)) {
    _json(res, 401, {
      error: { message: "未授权 · 缺少有效 Bearer key", type: "unauthorized" },
    });
    return true;
  }

  if (p === "/codex-hot/v1/models" && req.method === "GET") {
    _json(res, 200, { models: _codexHotModels(deps) });
    return true;
  }

  if (p === "/v1/models" && req.method === "GET") {
    const allModels = listModels(deps);
    // 模型外接选择: 对外仅呈现「已开启外接」之模型(用户排除者不列)。
    const models = allModels.filter((m) => m.exposed !== false);
    const data = models.slice();
    // 家族别名: 外部可用干净家族名(如 glm-5.1)调用「当前活跃档」· 一族一别名
    try {
      const fams = familySummary(deps, models);
      for (const f of fams) {
        if (!f.aliasSlug || f.aliasSlug === f.activeUid) continue;
        if (models.some((m) => m.id === f.aliasSlug)) continue;
        if (_isModelDisabled(cfg, f.activeUid, deps)) continue;
        const act = models.find((m) => m.id === f.activeUid) || {};
        data.push({
          id: f.aliasSlug,
          object: "model",
          created: 0,
          owned_by: "dao-revproxy",
          label: f.familyLabel,
          dao_family: true,
          dao_active_tier: f.activeUid,
          color: act.color,
          free: !!act.free,
        });
      }
    } catch (_) {}
    _json(res, 200, { object: "list", data });
    return true;
  }

  if (p === "/v1beta/models" && req.method === "GET") {
    const models = listModels(deps).filter((model) => model.exposed !== false);
    _json(res, 200, {
      models: models.map((model) => ({
        name: "models/" + model.id,
        baseModelId: model.id,
        version: "001",
        displayName: model.label || model.id,
        inputTokenLimit: 1048576,
        outputTokenLimit: cfg.defaultMaxTokens || 4096,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      })),
    });
    return true;
  }

  const isCodexHot = p === "/codex-hot/v1/responses" && req.method === "POST";
  const isCodexHotCompact = p === "/codex-hot/v1/responses/compact" && req.method === "POST";
  const isOpenAIResponsesCompact = (p === "/v1/responses/compact" || isCodexHotCompact) && req.method === "POST";
  const isOpenAIChat = p === "/v1/chat/completions" && req.method === "POST";
  const isOpenAIResponses = (p === "/v1/responses" || isCodexHot) && req.method === "POST";
  const isAnthropicMsg = p === "/v1/messages" && req.method === "POST";
  const geminiMatch = p.match(
    /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/,
  );
  const isGemini = !!geminiMatch && req.method === "POST";
  if (isOpenAIChat || isOpenAIResponses || isOpenAIResponsesCompact || isAnthropicMsg || isGemini) {
    const requestAcceptedAt = Date.now();
    const rate = _requestRateAllowed(req, p, cfg);
    if (!rate.ok) {
      const retryAfter = Math.max(1, Math.ceil(rate.retryAfterMs / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      _auditRequest(req, p, 429, req.headers && req.headers["content-length"]);
      _json(res, 429, { error: { message: "rate limit exceeded", type: "rate_limit_error" } });
      return true;
    }
    let body;
    try {
      body = await _readBody(req, { maxBytes: _requestGuardConfig(cfg).maxBodyBytes });
    } catch (e) {
      const status = e && e.code === "BODY_TOO_LARGE" ? 413 : 400;
      _auditRequest(req, p, status, req.headers && req.headers["content-length"]);
      _json(res, status, { error: { message: status === 413 ? "request body too large" : "invalid JSON body" } });
      return true;
    }
    _auditRequest(req, p, 200, req.headers && req.headers["content-length"], body && body.model);
    if (isGemini) {
      body.model = decodeURIComponent(geminiMatch[1]).replace(/^models\//, "");
      body.stream = geminiMatch[2] === "streamGenerateContent";
    }
    const clientKind = isAnthropicMsg
      ? "anthropic"
      : isOpenAIResponses || isOpenAIResponsesCompact
        ? "openai-responses"
        : isGemini
          ? "gemini"
          : "openai-chat";
    const norm = normalizeInbound(clientKind, body);
    if (!norm.model) {
      _json(res, 400, { error: { message: "model required" } });
      return true;
    }
    const requestObservation = isCodexHot || isCodexHotCompact
      ? {
          source: "codex",
          startedAt: requestAcceptedAt,
          cacheKeyHash: body.prompt_cache_key
            ? _cacheFingerprint(body.prompt_cache_key)
            : null,
          reasoningEffort:
            body.reasoning && typeof body.reasoning === "object"
              ? String(body.reasoning.effort || "").slice(0, 20)
              : "",
        }
      : { source: "external", startedAt: requestAcceptedAt };
    // Codex 独立热路由不占用③模型路由，也不受④对外模型开关影响。
    let requestDeps = deps;
    if (isCodexHot || isCodexHotCompact) {
      const hot = deps.getCodexHotRoute && deps.getCodexHotRoute();
      if (!hot || !hot.enabled || !hot.provider || !hot.model) {
        _json(res, 503, { error: { message: "Codex hot route is not configured", type: "codex_route_missing" } });
        return true;
      }
      const baseConfig = (deps.getEaConfig && deps.getEaConfig()) || {};
      const route = Object.assign({}, hot.route || {}, {
        provider: hot.provider,
        model: hot.model,
        protocol: hot.protocol,
        sourceProtocol: hot.protocol,
        reasoningLevel: hot.reasoningLevel,
        reasoningEffort: hot.reasoningLevel === "off" ? null : hot.reasoningLevel,
        thinkingEnabled: hot.reasoningLevel !== "off",
        autoFallback: false,
        enabled: true,
        _codexManaged: true,
      });
      requestDeps = Object.assign({}, deps, {
        getEaConfig: () => Object.assign({}, baseConfig, {
          daoRoutes: { routes: { [norm.model]: route } },
        }),
      });
    }
    // 模型外接选择: 用户已排除之模型拒绝对外反代(回归本源·各取所需)。
    if (!isCodexHot && !isCodexHotCompact && _isModelDisabled(cfg, norm.model, deps)) {
      _json(res, 403, {
        error: {
          message:
            "模型 '" +
            norm.model +
            "' 未开放外接 · 已被用户在「模型反代」面板排除(可在面板重新勾选启用)",
          type: "model_not_exposed",
        },
      });
      return true;
    }
    const targets = resolveTargets(norm.model, requestDeps);
    const target = targets[0];
    if (!target) {
      _json(res, 400, {
        error: {
          message:
            "模型 '" +
            norm.model +
            "' 未配置反代通道 · 请在「渠道配置 / 模型路由」为其指定渠道(或映射到已配置的免费渠道如 GLM)",
          type: "no_route",
        },
      });
      return true;
    }
    if (isOpenAIResponsesCompact) {
      const compactResult = await _forwardResponsesCompact(targets, body, requestDeps);
      const responseHeaders = {
        "Content-Type": compactResult.headers["content-type"] || "application/json",
        "Content-Length": String(compactResult.body.length),
      };
      if (compactResult.headers["x-request-id"])
        responseHeaders["x-request-id"] = compactResult.headers["x-request-id"];
      res.writeHead(compactResult.statusCode, responseHeaders);
      res.end(compactResult.body);
      return true;
    }
    const allowedProtocols =
      target.route && Array.isArray(target.route._targetProtocols)
        ? target.route._targetProtocols
        : null;
    if (allowedProtocols && !allowedProtocols.includes(clientKind)) {
      _json(res, 400, {
        error: {
          message:
            "模型 '" +
            norm.model +
            "' 未启用 " +
            clientKind +
            " 中转 · 已启用: " +
            allowedProtocols.join(", "),
          type: "protocol_not_enabled",
        },
      });
      return true;
    }
    log(
      "[revproxy] " +
        clientKind +
        " model=" +
        norm.model +
        " → " +
        (target.official
          ? "official/" + (target.upstreamModel || "")
          : target.provName + "/" + (target.upstreamModel || "")) +
        (targets.length > 1
          ? " (+备路 " +
            (targets[1].official ? "official" : targets[1].provName) +
            ")"
          : "") +
        " stream=" +
        norm.stream,
    );
    // ★ 缓存层 (opt-in · 仅非流式无工具的成功响应):
    //   ① exact-match (byte 级相同 · 同步 · 零风险)
    //   ② semantic    (embedding 余弦≥阈值 · 需配 embeddings 端点 · 有假阳性风险)
    //   命中任一层即回放跳过上游; 未命中则一次 tee 同时写回两层。
    const _ecCfg = (cfg && cfg.exactCache) || {};
    const _scCfg = (cfg && cfg.semanticCache) || {};
    const _toolCount = Array.isArray(norm.tools) ? norm.tools.length : 0;
    const _noStreamNoTools =
      !norm.stream &&
      _toolCount === 0 &&
      Array.isArray(norm.messages) &&
      norm.messages.length > 0;
    const _exactCacheable = _ecCfg.enabled === true && _noStreamNoTools;
    const _semanticCacheable =
      _scCfg.enabled === true &&
      _noStreamNoTools &&
      _scCfg.embed &&
      _scCfg.embed.baseUrl &&
      _scCfg.embed.model;
    let _ecKey = null;
    let _ec = null;
    let _sc = null;
    let _scVec = null;
    if (_exactCacheable) {
      _ec = _getExactCache(cfg);
      if (_ec) {
        _ecKey = _ec.makeKey({
          clientKind,
          provider: target.official ? "official" : target.provName || "",
          upstreamModel: target.upstreamModel || norm.model || "",
          messages: norm.messages || [],
          system: norm.system || "",
          tools: norm.tools || [],
          maxTokens: norm.maxTokens || 0,
          temperature: norm.temperature,
          topP: norm.topP,
          stop: norm.stop || "",
        });
        const cached = _ec.get(_ecKey);
        if (cached && cached.body) {
          const headers = Object.assign({}, cached.headers || {}, {
            "x-dao-cache": "hit",
          });
          res.writeHead(cached.status || 200, headers);
          res.end(Buffer.from(cached.body, "base64"));
          log(`[revproxy] exact-cache HIT ${clientKind} model=${norm.model}`);
          return true;
        }
      }
    }
    let _scNs = "";
    if (_semanticCacheable) {
      _sc = _getSemanticCache(cfg);
      if (_sc) {
        _scNs = _semanticNs(clientKind, target, norm);
        _scVec = await _embedText(
          _semanticEmbedText(norm, _scCfg.maxEmbedChars),
          _scCfg.embed,
          deps,
        );
        if (_scVec) {
          const sres = _sc.lookup(_scVec, _scNs);
          if (sres.hit && sres.value && sres.value.body) {
            const headers = Object.assign({}, sres.value.headers || {}, {
              "x-dao-cache": "semantic",
              "x-dao-cache-score": String(Math.round(sres.score * 1000) / 1000),
            });
            res.writeHead(sres.value.status || 200, headers);
            res.end(Buffer.from(sres.value.body, "base64"));
            log(
              `[revproxy] semantic-cache HIT ${clientKind} model=${norm.model} score=${Math.round(sres.score * 1000) / 1000}`,
            );
            return true;
          }
        }
      }
    }
    // miss: 一次 tee 同时写回 exact + semantic
    if ((_ec && _ecKey) || (_sc && _scVec)) {
      _teeUnaryResponse(res, (status, headers, buffer) => {
        if (status !== 200 || !buffer || buffer.length === 0) return;
        const stored = {
          status,
          headers: _cacheableHeaders(headers),
          body: buffer.toString("base64"),
        };
        if (_ec && _ecKey) _ec.set(_ecKey, stored);
        if (_sc && _scVec) _sc.store(_scVec, stored, _scNs);
      });
    }
    const gen = _bridge(targets, norm, requestDeps, requestObservation);
    if (clientKind === "anthropic") {
      if (norm.stream) _emitAnthropicStream(res, norm.model, gen);
      else _emitAnthropicUnary(res, norm.model, gen);
    } else if (clientKind === "openai-responses") {
      if (norm.stream) _emitResponsesStream(res, norm.model, gen);
      else _emitResponsesUnary(res, norm.model, gen);
    } else if (clientKind === "gemini") {
      if (norm.stream) _emitGeminiStream(res, norm.model, gen);
      else _emitGeminiUnary(res, norm.model, gen);
    } else {
      if (norm.stream) _emitOpenAIStream(res, norm.model, gen);
      else _emitOpenAIUnary(res, norm.model, gen);
    }
    return true;
  }

  // 兜底: /v1/* 未识别
  if (p.startsWith("/v1/") || p.startsWith("/v1beta/")) {
    _json(res, 404, { error: { message: "unknown endpoint " + p } });
    return true;
  }
  return false;
}

module.exports = {
  configure,
  getConfiguredConfigPath,
  handle,
  listModels,
  modelStats,
  loadConfig,
  saveConfig,
  defaultConfig,
  normalizeInbound,
  resolveTarget,
  resolveTargets,
  _routeChannelTargets,
  _altTarget,
  _isRetryableErr,
  setPremiumQuota,
  getPremiumQuota,
  _officialInfo,
  _isModelDisabled,
  _isFreeTier,
  buildFamilyIndex,
  familySummary,
  _familyActiveUid,
  _resolveFamilyAlias,
  _cfgPath,
  _isLocal,
  _isForwarded,
  _authOk,
  consoleHtml,
  requestGuardStatus,
  _classifyUpstreamError,
  _emitOpenAIStream,
  _emitAnthropicStream,
  _emitOpenAIUnary,
  __test: {
    teeUnaryResponse: _teeUnaryResponse,
    cacheableHeaders: _cacheableHeaders,
    getExactCache: _getExactCache,
    getSemanticCache: _getSemanticCache,
    semanticEmbedText: _semanticEmbedText,
    semanticNs: _semanticNs,
    embedText: _embedText,
  },
};

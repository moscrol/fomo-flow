"use strict";
/**
 * runtime.js · 外接api 运行时 · 道法自然
 * ════════════════════════════════════════════════════════════════
 *
 *   《帛书·四十八章》: "为道者日损 · 损之又损 · 以至于无为 · 无为而无不为"
 *   《阴符经》: "天生天杀 · 道之理也"
 *
 *   职能:
 *     1. 初始化 dao_router.js (模型路由核心)
 *     2. 初始化 cascade_wire.js (protobuf 编解码)
 *     3. 为 extension.js tryStartExternalApi 提供 ExternalApiRuntime 类
 *     4. 为 source.js 提供路由判断 + 路由执行
 *
 *   接口 (对 extension.js):
 *     new ExternalApiRuntime({ vscodeModule, logger, configKey, vendorPrefix })
 *     .start()   → { gatewayUrl, providers, models }
 *     .stop()    → void
 *     .isRunning() → bool
 *     .getStatus() → { gatewayUrl, providers, models, routerReady, routerCount }
 *
 *   接口 (对 source.js):
 *     getRouter()  → dao_router 实例 (null if not ready)
 *     shouldRoute(modelUid) → bool
 *     route(req, res, rawBody, isJSON, modelUid) → Promise<bool>
 *
 *   v9.9.59 · 从 070-插件_Plugins/外接api/01-外接api模型路由/runtime.js 归宗
 *     修 DEFECT2: vendor/外接api/runtime.js 缺失 → tryStartExternalApi 永抛异常
 */

const path = require("path");
const fs = require("fs");
const { resolveStateDir } = require("../../core/product_identity.js");

// ── 核心模块路径 ──
const CORE_DIR = path.join(__dirname, "core");
const ROUTER_PATH = path.join(CORE_DIR, "dao_router.js");
const WIRE_PATH = path.join(CORE_DIR, "cascade_wire.js");
let _cachedRouterModule = null;
let _cachedRouterInitialized = false;
let _configuredConfigPath = null;
const _configuredConfigPathGlobal = "__daoExternalApiConfiguredConfigPath";

function _routerInitSucceeded(result) {
  return !!result && !result.error;
}

/**
 * Desktop host injection point. It deliberately does not set process.env so a
 * Desktop runtime can coexist with the VSIX in the same user account.
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

// ── 配置路径查找 ──
//   1. 用户级: ~/.codeium/dao-byok/配置.json (跨 VSIX install 持久)
//   2. 同目录: core/配置.json (VSIX 内自包含)
//   3. 环境变量: DAO_BYOK_CONFIG
function _resolveConfigPath() {
  const configuredPath = getConfiguredConfigPath();
  if (configuredPath) return configuredPath;
  const envConfig = process.env.FOMO_BYOK_CONFIG || process.env.DAO_BYOK_CONFIG;
  if (envConfig && fs.existsSync(envConfig)) {
    return path.resolve(envConfig);
  }
  const bundledCfg = path.join(CORE_DIR, "配置.json");
  const bundledTpl = path.join(CORE_DIR, "_默认配置.json");
  const userDir = resolveStateDir();
  if (userDir) {
    const userCfg = path.join(userDir, "配置.json");
    if (fs.existsSync(userCfg)) return userCfg;
    // 用户级配置不存在 → 即刻于用户级播种并接管 · 跨 VSIX install 持久
    //   反者道之动: 凭据/渠道安于本机 ~/.codeium · 绝不入库 · 升级重装不失
    //   播种优先 bundled 配置.json (含预设渠道·迁移既有态), 退 _默认配置.json (无凭据模板)
    try {
      fs.mkdirSync(userDir, { recursive: true });
      const seed = fs.existsSync(bundledCfg)
        ? bundledCfg
        : fs.existsSync(bundledTpl)
          ? bundledTpl
          : null;
      if (seed) fs.copyFileSync(seed, userCfg);
      // 即便无模板亦返回用户路径 · dao_router.init 会内嵌兜底生成于此
      return userCfg;
    } catch (_e) {
      // 用户级创建失败 (权限等) → 退回 bundled 只读兜底
    }
  }
  if (fs.existsSync(bundledCfg)) return bundledCfg;
  return bundledCfg; // 默认 (dao_router init 会自动生成模板)
}

// ════════════════════════════════════════════════════════════════
// ExternalApiRuntime · extension.js 用
// ════════════════════════════════════════════════════════════════

class ExternalApiRuntime {
  constructor(opts = {}) {
    this._vscode = opts.vscodeModule || null;
    this._log = opts.logger || {
      info: console.log,
      warn: console.warn,
      error: console.error,
    };
    this._configKey = opts.configKey || "dao.外接api";
    this._vendorPrefix = opts.vendorPrefix || "dao-";
    this._router = null;
    this._wire = null;
    this._running = false;
    this._gatewayUrl = "";
    this._configPath = "";
    this._channelFailureListener = null;
    this._lastChannelFailureNotice = new Map();
  }

  async start() {
    if (this._running) return this.getStatus();

    if (this._vscode && !this._channelFailureListener) {
      this._channelFailureListener = (details) => {
        try {
          const id = String(
            (details && (details.customModelId || details.modelUid)) || "自定义模型",
          );
          const signature = `${id}|${JSON.stringify((details && details.channels) || [])}`;
          const now = Date.now();
          const last = this._lastChannelFailureNotice.get(signature) || 0;
          if (now - last < 60000) return;
          this._lastChannelFailureNotice.set(signature, now);
          const failures = Array.isArray(details && details.failures)
            ? details.failures
            : [];
          const summary = failures
            .slice(0, 4)
            .map(
              (failure) =>
                `${failure.provider}/${failure.model}: ${failure.status || "网络"}`,
            )
            .join("；");
          const message = `自定义模型 ${id} 的全部渠道均失败${summary ? `：${summary}` : ""}`;
          this._vscode.window
            .showErrorMessage(message, "打开自定义模型设置")
            .then((choice) => {
              if (choice === "打开自定义模型设置") {
                this._vscode.commands.executeCommand("fomo.eaConfig");
              }
            });
        } catch {}
      };
      process.on(
        "dao:custom-model-channels-failed",
        this._channelFailureListener,
      );
    }

    // 加载 dao_router
    try {
      const Router = _cachedRouterModule || require(ROUTER_PATH);
      _cachedRouterModule = Router;
      this._configPath = _resolveConfigPath();
      const result = Router.init({
        log: (msg) => {
          try {
            this._log.info("外接api", msg);
          } catch {}
        },
        configPath: this._configPath,
      });
      _cachedRouterInitialized = _routerInitSucceeded(result);
      if (result.ready) {
        this._router = Router;
        this._gatewayUrl = result.gateway || "";
        this._running = true;
        this._log.info(
          "外接api",
          `路由就绪 · ${result.count}条 · gw=${this._gatewayUrl}`,
        );
      } else {
        this._log.warn(
          "外接api",
          `路由未就绪: ${result.error || result.reason || "unknown"}`,
        );
      }
    } catch (e) {
      _cachedRouterInitialized = false;
      this._log.warn("外接api", `dao_router load fail: ${e.message}`);
    }

    // 加载 cascade_wire
    try {
      this._wire = require(WIRE_PATH);
    } catch (e) {
      this._log.warn("外接api", `cascade_wire load fail: ${e.message}`);
      this._wire = null;
    }

    return this.getStatus();
  }

  async stop() {
    if (this._channelFailureListener) {
      process.removeListener(
        "dao:custom-model-channels-failed",
        this._channelFailureListener,
      );
      this._channelFailureListener = null;
    }
    this._lastChannelFailureNotice.clear();
    this._router = null;
    this._wire = null;
    this._running = false;
  }

  isRunning() {
    return this._running && this._router && this._router.isReady();
  }

  getStatus() {
    const routerStatus = this._router ? this._router.status() : null;
    return {
      gatewayUrl: this._gatewayUrl,
      providers: routerStatus ? routerStatus.providers : [],
      models: routerStatus ? routerStatus.count : 0,
      routerReady: routerStatus ? routerStatus.ready : false,
      routerCount: routerStatus ? routerStatus.count : 0,
      contextStrategy: routerStatus ? routerStatus.contextStrategy : null,
      toolStrategy: routerStatus ? routerStatus.toolStrategy : null,
      toolOutputStore: routerStatus ? routerStatus.toolOutputStore : null,
      configPath: this._configPath,
      wire: !!this._wire,
    };
  }

  /** 对 source.js 暴露路由器 */
  getRouter() {
    return this._running ? this._router : null;
  }

  agentStatusList() {
    return this._router && this._router.agentStatusList
      ? this._router.agentStatusList()
      : [];
  }

  agentStatusSubscribe(listener) {
    return this._router && this._router.agentStatusSubscribe
      ? this._router.agentStatusSubscribe(listener)
      : { dispose() {} };
  }

  agentStatusSetMode(key, mode) {
    return this._router && this._router.agentStatusSetMode
      ? this._router.agentStatusSetMode(key, mode)
      : null;
  }

  agentStatusOptions() {
    return this._router && this._router.agentStatusOptions
      ? this._router.agentStatusOptions()
      : { enabled: false, hud: { enabled: false } };
  }

  getWire() {
    return this._wire;
  }
}

// ════════════════════════════════════════════════════════════════
// 模块级单例 · source.js 直接 require 本文件即可用
// ════════════════════════════════════════════════════════════════

let _singleton = null;

/**
 * 获取/创建模块级单例
 * source.js 在模块顶层调一次: const ea = require("../外接api/runtime.js").ensure({log});
 * 之后在 _mainHandler 中用 ea.shouldRoute() / ea.route()
 */
function ensure(opts = {}) {
  if (!_singleton) {
    _singleton = new ExternalApiRuntime(opts);
    let configPath = "";
    // 自动初始化 (不 await — source.js 模块顶层不能 await)
    // 但我们可以同步做 init (dao_router.init 是同步的)
    try {
      const Router = _cachedRouterModule || require(ROUTER_PATH);
      _cachedRouterModule = Router;
      configPath = _resolveConfigPath();
      _singleton._configPath = configPath;
      const result = Router.init({
        log:
          opts.log ||
          ((msg) => {
            try {
              console.log(msg);
            } catch {}
          }),
        configPath,
      });
      _cachedRouterInitialized = _routerInitSucceeded(result);
      if (result.ready) {
        _singleton._router = Router;
        _singleton._gatewayUrl = result.gateway || "";
        _singleton._running = true;
      }
    } catch (e) {
      _cachedRouterInitialized = false;
      try {
        (opts.log || console.log)(`[外接api] ensure init fail: ${e.message}`);
      } catch {}
    }
    try {
      _singleton._wire = require(WIRE_PATH);
    } catch {}
    // SWE 路由守护: provider 探活 + desired/degraded 自动切换
    try {
      const guard = require(path.join(CORE_DIR, "swe_route_guard.js"));
      const logFn =
        opts.log ||
        ((msg) => {
          try {
            console.log(msg);
          } catch {}
        });
      guard.startSweRouteGuard({ log: logFn, configPath });
      _singleton._sweRouteGuard = guard;
    } catch (e) {
      try {
        (opts.log || console.log)(
          `[外接api] swe-route-guard start fail: ${e && e.message}`,
        );
      } catch {}
    }
  }
  return _singleton;
}

/**
 * 快速路由判断 (source.js 用)
 * @param {string} modelUid
 * @returns {boolean}
 */
function shouldRoute(modelUid) {
  const R = _getRouterModule();
  return R ? R.shouldRoute(modelUid) : false;
}

/**
 * 从 rawBody 提取 modelUid (source.js 用)
 * @param {Buffer} rawBody
 * @param {boolean} isJSON
 * @returns {string|null}
 */
function extractModelUid(rawBody, isJSON) {
  const R = _getRouterModule();
  return R ? R.extractModelUid(rawBody, isJSON) : null;
}

/**
 * 执行路由 (source.js 用)
 * @returns {Promise<boolean>} true=已路由并响应 / false=应走原路
 */
async function route(req, res, rawBody, isJSON, modelUid) {
  const R = _getRouterModule();
  return R ? R.route(req, res, rawBody, isJSON, modelUid) : false;
}

/** 路由器状态 (source.js /origin/ping 用) */
// ★ v9.9.92-fix · 用 _getRouterModule() 代替 _singleton._router
//   道义: 二十八章「知其白守其辱」· 热添加路由后 _ready=true · 但 _singleton._router=null
//   根因: ensure() 时 init 返回 ready=false → _singleton._router=null
//         hotAddRoute 修改模块级 _routes → _ready=true · 但 _singleton._router 未更新
//   修正: routerStatus 走 _getRouterModule() · 与 hotAddRoute 同源 · 名实相符
function routerStatus() {
  const R = _getRouterModule();
  return R ? R.status() : { ready: false, count: 0 };
}

/** v9.9.301 · 用量聚合 (按渠道/模型) · 供「外接API」面板查看 */
function routerUsage() {
  const R = _getRouterModule();
  return R && R.usage ? R.usage() : {};
}

/** v9.9.351 · 外部记账: 非 Cascade 路径(模型反代等)用量归入同一张表 */
function routerRecordUsage(providerName, model, tc, observation) {
  const R = _getRouterModule();
  if (R && R.recordUsage) {
    try {
      R.recordUsage(providerName, model, tc, observation);
    } catch (_) {}
  }
}

function agentStatusList() {
  const R = _getRouterModule();
  return R && R.agentStatusList ? R.agentStatusList() : [];
}

function agentStatusSubscribe(listener) {
  const R = _getRouterModule();
  return R && R.agentStatusSubscribe
    ? R.agentStatusSubscribe(listener)
    : { dispose() {} };
}

function agentStatusSetMode(key, mode) {
  const R = _getRouterModule();
  return R && R.agentStatusSetMode ? R.agentStatusSetMode(key, mode) : null;
}

function agentStatusOptions() {
  const R = _getRouterModule();
  return R && R.agentStatusOptions
    ? R.agentStatusOptions()
    : { enabled: false, hud: { enabled: false } };
}

/** substitute模式: 获取替代目标UID (source.js 用) */
function getSubstitution(modelUid) {
  const R = _getRouterModule();
  return R ? R.getSubstitution(modelUid) : null;
}

/** substitute模式: patch protobuf field 21 (source.js 用) */
function patchModelUid(rawBody, isJSON, oldUid, newUid) {
  const R = _getRouterModule();
  return R ? R.patchModelUid(rawBody, isJSON, oldUid, newUid) : null;
}

// ════════════════════════════════════════════════════════════════
// ★ v9.9.90 · 热配置 API 透传 · 道法自然 · 无为而无不为
//   五十七章「我无为也 而民自化」· 热操作 · 不重启 · 即时生效
//   供 source.js /origin/ea/* 控制面 + extension.js webview 使用
//   ★ v9.9.90-fix · router 未运行时也能读写配置 · 名实相符
// ════════════════════════════════════════════════════════════════

// ★ 惰性获取 router 模块 · 即使 _singleton._router 为 null (外接api disabled)
//   也能直接 require dao_router.js 并 init · 让 webview 始终可读写配置
function _getRouterModule() {
  // 1. 优先用运行中的 router (热更新直接生效)
  if (_singleton && _singleton._router) return _singleton._router;
  // 2. init() 会为热重载清理 require.cache，facade 必须持有单独引用。
  if (_cachedRouterModule && _cachedRouterInitialized)
    return _cachedRouterModule;
  // 3. 惰性 require + init (外接api disabled 时也能操作配置)
  try {
    const Router = _cachedRouterModule || require(ROUTER_PATH);
    _cachedRouterModule = Router;
    if (Router.isReady()) {
      _cachedRouterInitialized = true;
      return Router;
    }
    // 未 init → 用默认配置路径 init
    const configPath =
      (_singleton && _singleton._configPath) || _resolveConfigPath();
    if (!configPath) return null;
    const result = Router.init({ log: () => {}, configPath });
    _cachedRouterInitialized = _routerInitSucceeded(result);
    return _cachedRouterInitialized ? Router : null;
  } catch {
    _cachedRouterInitialized = false;
    return null;
  }
}

function hotAddProvider(name, cfg) {
  const R = _getRouterModule();
  return R
    ? R.hotAddProvider(name, cfg)
    : { ok: false, error: "router module not loadable" };
}

function hotRemoveProvider(name) {
  const R = _getRouterModule();
  return R
    ? R.hotRemoveProvider(name)
    : { ok: false, error: "router module not loadable" };
}

function hotAddRoute(modelUid, routeCfg) {
  const R = _getRouterModule();
  return R
    ? R.hotAddRoute(modelUid, routeCfg)
    : { ok: false, error: "router module not loadable" };
}

function hotRemoveRoute(modelUid) {
  const R = _getRouterModule();
  return R
    ? R.hotRemoveRoute(modelUid)
    : { ok: false, error: "router module not loadable" };
}

// ★ v9.9.97 · 热切换兼容别名
function hotDeleteRoute(modelUid) {
  const R = _getRouterModule();
  return R
    ? R.hotDeleteRoute(modelUid)
    : { ok: false, error: "router module not loadable" };
}

// ★ v9.9.97 · 解锁保护模型
function unlockModel(modelUid, unlock) {
  const R = _getRouterModule();
  return R
    ? R.unlockModel(modelUid, unlock)
    : { ok: false, error: "router module not loadable" };
}

// ★ v9.9.97 · 检查模型是否被保护
function isModelProtected(modelUid) {
  const R = _getRouterModule();
  return R ? R.isModelProtected(modelUid) : false;
}

function hotGetConfig() {
  const R = _getRouterModule();
  return R
    ? R.hotGetConfig()
    : { ok: false, error: "router module not loadable" };
}

function hotConfigFingerprint() {
  const R = _getRouterModule();
  return R && R.hotConfigFingerprint ? R.hotConfigFingerprint() : "";
}

function hotSetConfig(newCfg) {
  const R = _getRouterModule();
  return R
    ? R.hotSetConfig(newCfg)
    : { ok: false, error: "router module not loadable" };
}

// SWE 路由守护热重载 · 旧模块的 setInterval 不会因改盘上代码而停。
// 守护把定时器句柄存在 globalThis, 故新模块 startSweRouteGuard() 内的
// stopSweRouteGuard() 能清掉旧模块建的那一枚 —— 前提是先清 require.cache
// 让 require 真拿到新代码。原先 hotReload 只清 router 的缓存, 守护改动
// 必须整个 reload window 才生效, 探活计费闸门因此长期失效。
function _reloadSweRouteGuard(log) {
  const guardPath = path.join(CORE_DIR, "swe_route_guard.js");
  try {
    const prev = _singleton && _singleton._sweRouteGuard;
    if (prev && typeof prev.stopSweRouteGuard === "function") {
      prev.stopSweRouteGuard();
    }
  } catch {}
  try {
    delete require.cache[require.resolve(guardPath)];
  } catch {}
  try {
    const guard = require(guardPath);
    const logFn =
      log ||
      ((msg) => {
        try {
          console.log(msg);
        } catch {}
      });
    const started = guard.startSweRouteGuard({ log: logFn });
    if (_singleton) _singleton._sweRouteGuard = guard;
    return { ok: true, intervalMs: started && started.intervalMs };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
}

function hotReload() {
  const R = _getRouterModule();
  const guard = _reloadSweRouteGuard();
  if (!R) return { ok: false, error: "router module not loadable", guard };
  const result = R.hotReload();
  return Object.assign({}, result, { guard });
}

async function hotListProviderModels(providerName, opts) {
  const R = _getRouterModule();
  return R
    ? R.hotListProviderModels(providerName, opts)
    : { ok: false, error: "router module not loadable" };
}

function hotListCustomModels() {
  const R = _getRouterModule();
  return R && R.hotListCustomModels ? R.hotListCustomModels() : [];
}

function hotGetModelCapability(providerName, model) {
  const R = _getRouterModule();
  return R && R.hotGetModelCapability
    ? R.hotGetModelCapability(providerName, model)
    : { ok: false, error: "router module not loadable" };
}

function hotUpsertCustomModel(input) {
  const R = _getRouterModule();
  return R && R.hotUpsertCustomModel
    ? R.hotUpsertCustomModel(input)
    : { ok: false, error: "router module not loadable" };
}

function hotRemoveCustomModel(id) {
  const R = _getRouterModule();
  return R && R.hotRemoveCustomModel
    ? R.hotRemoveCustomModel(id)
    : { ok: false, error: "router module not loadable" };
}

function hotCustomModelCatalog() {
  const R = _getRouterModule();
  return R && R.hotCustomModelCatalog ? R.hotCustomModelCatalog() : [];
}

// ★ v9.9.90-fix · 命名对齐: dao_router.js 导出 resetHealthCache / probeAllProviders
function hotResetHealthCache() {
  const R = _getRouterModule();
  if (R) R.resetHealthCache();
}

async function hotProbeAllProviders() {
  const R = _getRouterModule();
  return R ? R.probeAllProviders() : {};
}

// ★ v9.9.285 · 最近一次探活快照 (非阻塞) · 供 overview 即时展示渠道连通+原因
function hotHealthSnapshot() {
  const R = _getRouterModule();
  return R && R.healthSnapshot ? R.healthSnapshot() : {};
}

// ★ v9.9.285 · 渠道响应分类器透传 · 供 test-chat 实证渠道伪成功/拒绝
function classifyChannelResponse(status, text) {
  const R = _getRouterModule();
  return R && R.classifyChannelResponse
    ? R.classifyChannelResponse(status, text)
    : { ok: true, reason: "" };
}

// ★ v9.9.92-fix · 获取 wire 模块 · 供 source.js 构建 Connect-RPC 错误帧
//   道义: 三十九章「得一以宁」· 得 wire 方能构建正确帧格式
function getWire() {
  if (_singleton && _singleton._wire) return _singleton._wire;
  try {
    return require(WIRE_PATH);
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// ★ v9.9.99 · AI 热配置接口 · Go 移植模块透传
//   道义: 太上 下知有之 · 底层全开放 · AI可辅助用户配置一切
// ════════════════════════════════════════════════════════════════

function hotSetBudgetParam(key, value) {
  const R = _getRouterModule();
  return R
    ? R.hotSetBudgetParam(key, value)
    : { ok: false, error: "router not loaded" };
}

function hotGetBudgetStatus() {
  const R = _getRouterModule();
  return R ? R.hotGetBudgetStatus() : null;
}

function hotCountTokens(text, encoder) {
  const R = _getRouterModule();
  return R
    ? R.hotCountTokens(text, encoder)
    : { tokens: -1, encoder: "unavailable" };
}

function hotDetectProtocol(providerName) {
  const R = _getRouterModule();
  return R
    ? R.hotDetectProtocol(providerName)
    : { protocol: "openai-chat", supported: ["openai-chat"] };
}

function hotGetModelContextLength(model) {
  const R = _getRouterModule();
  return R ? R.hotGetModelContextLength(model) : { contextLength: 128000 };
}

function hotSetResilienceParam(key, value) {
  const R = _getRouterModule();
  return R
    ? R.hotSetResilienceParam(key, value)
    : { ok: false, error: "router not loaded" };
}

function hotDetectRefusal(text) {
  const R = _getRouterModule();
  return R ? R.hotDetectRefusal(text) : { isRefusal: false };
}

function hotCompactSchema(schema, stripDoc) {
  const R = _getRouterModule();
  return R ? R.hotCompactSchema(schema, stripDoc) : schema;
}

// ★ 可观测与配置历史透传 · 供 /origin/ea/* 控制面 + MCP 工具使用
function routerTraces(limit) {
  const R = _getRouterModule();
  return R && R.getRecentTraces ? R.getRecentTraces(limit) : [];
}

function routerAlerts(sinceId, limit) {
  const R = _getRouterModule();
  if (!R) return [];
  if (sinceId) return R.getAlertsSince ? R.getAlertsSince(sinceId, limit) : [];
  return R.getRecentAlerts ? R.getRecentAlerts(limit) : [];
}

function routerFailureStats() {
  const R = _getRouterModule();
  return R && R.getFailureStats ? R.getFailureStats() : {};
}

// ★ 全局选项(OTEL 导出 + Cascade 出站脱敏)读写 · 供 /origin/ea/* 面板
function routerGlobalOptions() {
  const R = _getRouterModule();
  return R && R.getGlobalOptions ? R.getGlobalOptions() : null;
}

function routerSetGlobalOptions(patch) {
  const R = _getRouterModule();
  return R && R.hotSetGlobalOptions
    ? R.hotSetGlobalOptions(patch)
    : { ok: false, error: "router unavailable" };
}

function routerAuditLog(limit) {
  const R = _getRouterModule();
  return R && R.getAuditLog ? R.getAuditLog(limit) : [];
}

function routerRoutingDecisions(profile, limit) {
  const R = _getRouterModule();
  return R && R.getRoutingDecisions ? R.getRoutingDecisions(profile, limit) : [];
}

function routerPreflightRoute(input) {
  const R = _getRouterModule();
  return R && R.preflightRoute
    ? R.preflightRoute(input)
    : { ok: false, status: 503, error: { code: "RUNTIME_UNAVAILABLE", message: "router module not loadable" } };
}

function routerDecisionInbox(limit) {
  const R = _getRouterModule();
  return R && R.getDecisionInbox ? R.getDecisionInbox(limit) : [];
}

function routerAcknowledgeDecision(id) {
  const R = _getRouterModule();
  return R && R.acknowledgeDecision ? R.acknowledgeDecision(id) : null;
}

function routerSnoozeDecision(id, minutes) {
  const R = _getRouterModule();
  return R && R.snoozeDecision ? R.snoozeDecision(id, minutes) : null;
}

function routerRouteEvidence(limit) {
  const R = _getRouterModule();
  return R && R.getRouteEvidence ? R.getRouteEvidence(limit) : [];
}

function hotListConfigBackups() {
  const R = _getRouterModule();
  return R && R.hotListConfigBackups
    ? R.hotListConfigBackups()
    : { ok: false, error: "router module not loadable" };
}

function hotRollbackConfig(backupName) {
  const R = _getRouterModule();
  return R && R.hotRollbackConfig
    ? R.hotRollbackConfig(backupName)
    : { ok: false, error: "router module not loadable" };
}

function hotExportConfigPack() {
  const R = _getRouterModule();
  return R && R.hotExportConfigPack
    ? R.hotExportConfigPack()
    : { ok: false, error: "router module not loadable" };
}

function hotImportConfigPack(pack) {
  const R = _getRouterModule();
  return R && R.hotImportConfigPack
    ? R.hotImportConfigPack(pack)
    : { ok: false, error: "router module not loadable" };
}

module.exports = {
  ExternalApiRuntime,
  configure,
  getConfiguredConfigPath,
  ensure,
  shouldRoute,
  extractModelUid,
  route,
  routerStatus,
  routerUsage,
  routerRecordUsage,
  agentStatusList,
  agentStatusSubscribe,
  agentStatusSetMode,
  agentStatusOptions,
  getSubstitution,
  patchModelUid,
  // ★ 热配置 API
  hotAddProvider,
  hotRemoveProvider,
  hotAddRoute,
  hotRemoveRoute,
  hotDeleteRoute,
  hotGetConfig,
  hotConfigFingerprint,
  hotSetConfig,
  hotReload,
  hotListProviderModels,
  hotListCustomModels,
  hotGetModelCapability,
  hotUpsertCustomModel,
  hotRemoveCustomModel,
  hotCustomModelCatalog,
  hotResetHealthCache,
  hotProbeAllProviders,
  hotHealthSnapshot,
  classifyChannelResponse,
  // ★ v9.9.97 · 保护模型 API
  unlockModel,
  isModelProtected,
  getWire,
  // ★ v9.9.99 · AI 热配置接口 · Go 移植模块
  hotSetBudgetParam,
  hotGetBudgetStatus,
  hotCountTokens,
  hotDetectProtocol,
  hotGetModelContextLength,
  hotSetResilienceParam,
  hotDetectRefusal,
  hotCompactSchema,
  // ★ 可观测与配置历史
  routerTraces,
  routerAlerts,
  routerFailureStats,
  routerGlobalOptions,
  routerSetGlobalOptions,
  routerAuditLog,
  routerRoutingDecisions,
  routerPreflightRoute,
  routerDecisionInbox,
  routerAcknowledgeDecision,
  routerSnoozeDecision,
  routerRouteEvidence,
  hotListConfigBackups,
  hotRollbackConfig,
  hotExportConfigPack,
  hotImportConfigPack,
};

"use strict";
/**
 * swe_route_guard.js · terra 探活 + SWE 路由自动恢复
 *
 * 目标：
 *  - 官方 uid 仅 swe-1-6-fast / MODEL_SWE_1_6_FAST 走 GLM
 *  - 其余 SWE 档保持用户原路由（base→terra/ay，slow→ay/terra）
 *  - terra 暂挂时：base 临时降级为 ay 优先（不碰 fast）
 *  - terra 探活成功：自动写回 desired 原路由
 *
 * 配置文件：~/.codeium/dao-byok/swe-route-guard.json
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");
const { resolveStateDir } = require("../../../core/product_identity.js");

const BYOK_DIR = resolveStateDir() || path.join(os.homedir(), ".fomo-flow");
const GUARD_PATH = path.join(BYOK_DIR, "swe-route-guard.json");
const CFG_PATH = path.join(BYOK_DIR, "配置.json");
let _configuredConfigPath = null;
const _configuredConfigPathGlobal = "__daoSweRouteGuardConfiguredConfigPath";

function configure(opts = {}) {
  if (opts.configPath === undefined || opts.configPath === null || opts.configPath === "") {
    _configuredConfigPath = null;
    try { delete globalThis[_configuredConfigPathGlobal]; } catch (_) {}
    return null;
  }
  _configuredConfigPath = path.resolve(String(opts.configPath));
  try { globalThis[_configuredConfigPathGlobal] = _configuredConfigPath; } catch (_) {}
  return _configuredConfigPath;
}

function getConfiguredConfigPath() {
  return _configuredConfigPath || globalThis[_configuredConfigPathGlobal] || null;
}

function runtimePaths() {
  const configPath = getConfiguredConfigPath() || CFG_PATH;
  return {
    configPath,
    guardPath: path.join(path.dirname(configPath), "swe-route-guard.json"),
  };
}

// ── 探活亦是钱 · 无活动则不探 ──────────────────────────────────────
// 探活走真 chat 端点(max_tokens=8 · "ping"), 上游按真实请求计费。IDE 只是
// 挂着、无人对话时, 每 30s 一发, 实测账单每笔 4,387 prompt / 5 completion。
// 且本探活直连 provider baseUrl (不经 dao_router), 故不入 _recordUsage 用量
// 表 —— 账单有、面板无, 极难自证。
// 活动戳由主 session 的 session/prompt 刷新
// (dao-acp-stdio-proxy.js · touchSummaryActivity), 与摘要冷却同一枚文件。
// 无活动记录 = 从未用过 = 不探; 真实请求一来即刷戳, 下一 tick 自然复探。
const ACTIVITY_PATH =
  process.env.DAO_ACP_SUMMARY_ACTIVITY_FILE ||
  path.join(
    os.homedir(),
    ".local",
    "share",
    "devin",
    "cli",
    "dao-acp-summary-activity.json",
  );
const IDLE_COOLDOWN_MS =
  parseInt(String(process.env.DAO_SWE_GUARD_IDLE_MS || ""), 10) || 300000; // 5 min

function _isIdle() {
  let lastActiveAt = 0;
  try {
    const d = JSON.parse(fs.readFileSync(ACTIVITY_PATH, "utf8"));
    const parsed = Number(d && d.lastActiveAt);
    if (Number.isFinite(parsed) && parsed > 0) lastActiveAt = parsed;
  } catch {}
  return Date.now() - lastActiveAt > IDLE_COOLDOWN_MS;
}

const _SCHEDULER_KEY = "__daoFlowSweRouteGuardScheduler";
const _scheduler = globalThis[_SCHEDULER_KEY] || (globalThis[_SCHEDULER_KEY] = {
  interval: null,
  first: null,
});
let _lastState = null; // "alive" | "dead"
let _log = () => {};
let _busy = false;
let _lastWriteAt = 0;

function _defaultLog(msg) {
  try {
    console.error(msg);
  } catch {}
}

function _readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function _atomicWriteJson(fp, obj) {
  const data = JSON.stringify(obj, null, 2) + "\n";
  const tmp = `${fp}.tmp-swe-guard-${process.pid}`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, fp);
}

function _routeSig(r) {
  if (!r || typeof r !== "object") return "";
  return JSON.stringify({
    provider: r.provider || "",
    model: r.model || "",
    channelPriority: r.channelPriority || [],
    autoFallback: r.autoFallback,
  });
}

function _applyTemplate(cfg, template) {
  const routes = (cfg.daoRoutes && cfg.daoRoutes.routes) || {};
  let changed = false;
  for (const [k, v] of Object.entries(template || {})) {
    if (!v) continue;
    const next = JSON.parse(JSON.stringify(v));
    const prev = routes[k];
    if (_routeSig(prev) !== _routeSig(next)) {
      routes[k] = Object.assign({}, prev || {}, next);
      changed = true;
    }
  }
  // 硬约束：除 fast 外，SWE 族不得主挂 glm
  for (const k of Object.keys(routes)) {
    const kl = k.toLowerCase();
    if (!kl.includes("swe-1-6") && !k.includes("SWE_1_6")) continue;
    if (kl.includes("fast") || k.includes("FAST")) continue;
    if (routes[k] && routes[k].provider === "glm") {
      // 被误写成 glm 时强制不应用（留给 template 修正）
      changed = true;
    }
  }
  if (cfg.daoRoutes) cfg.daoRoutes.routes = routes;
  return changed;
}

function _postJson(urlStr, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      resolve({ ok: false, reason: `bad-url: ${e.message}` });
      return;
    }
    const lib = u.protocol === "http:" ? http : https;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + (u.search || ""),
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Length": data.length,
        },
        timeout: timeoutMs || 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          // 必须是聊天 JSON，不能是 200 HTML 壳页
          let alive = false;
          let reason = `HTTP ${res.statusCode}`;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const t = (text || "").trim();
            if (t.startsWith("<!doctype") || t.startsWith("<html") || t.startsWith("<HTML")) {
              alive = false;
              reason = "http-200-html-not-api";
            } else {
              try {
                const j = JSON.parse(t);
                // OpenAI chat / Anthropic messages / error object
                if (j.error) {
                  alive = false;
                  reason =
                    (j.error && (j.error.message || j.error.code || j.error.type)) ||
                    "json-error";
                } else if (
                  j.choices ||
                  j.content ||
                  j.id ||
                  j.type === "message" ||
                  j.object
                ) {
                  alive = true;
                  reason = "ok";
                } else {
                  alive = false;
                  reason = "json-not-chat-shape";
                }
              } catch {
                alive = false;
                reason = "http-200-non-json";
              }
            }
          }
          resolve({
            ok: alive,
            status: res.statusCode,
            body: text.slice(0, 300),
            reason,
          });
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, reason: e.message }));
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {}
      resolve({ ok: false, reason: "timeout" });
    });
    req.write(data);
    req.end();
  });
}

function resolveProviderEndpoint(provider, protocol) {
  const p = provider || {};
  const base = String(p.baseUrl || "").replace(/\/+$/, "");
  if (!base) return "";

  const isAnthropic =
    protocol === "anthropic" || String(protocol || "").includes("anthropic");
  const endpointPattern = isAnthropic
    ? /\/v1\/messages$/
    : /\/chat\/completions$/;
  if (endpointPattern.test(base)) return base;

  const configuredPath = String(p.completionPath || "").trim();
  const fallbackPath = isAnthropic
    ? "/v1/messages"
    : "/v1/chat/completions";
  const completionPath = configuredPath || fallbackPath;
  return `${base}/${completionPath.replace(/^\/+/, "")}`;
}

async function probeProvider(cfg, providerName, model) {
  const p = (cfg.providers || {})[providerName];
  if (!p) return { alive: false, reason: "provider-missing" };
  if (p.enabled === false) return { alive: false, reason: "provider-disabled" };
  const key = p.apiKey || "";
  if (!key) return { alive: false, reason: "no-api-key" };
  const base = String(p.baseUrl || "").replace(/\/$/, "");
  if (!base) return { alive: false, reason: "no-base-url" };

  const type = p.type || p.protocol || "openai-compatible";
  const isAnthropic =
    type === "anthropic" || String(p.protocol || "").includes("anthropic");

  if (isAnthropic) {
    const url = resolveProviderEndpoint(p, "anthropic");
    return _postJson(
      url,
      {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      {
        model: model || (p.models && p.models[0]) || "claude-opus-5",
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }],
      },
      15000,
    );
  }

  // OpenAI-compatible chat
  const url = resolveProviderEndpoint(p, "openai-chat");
  return _postJson(
    url,
    { Authorization: `Bearer ${key}` },
    {
      model: model || (p.models && p.models[0]) || "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 8,
    },
    15000,
  );
}

function _tick() {
  if (_busy) return;
  _busy = true;
  (async () => {
    try {
      const { guardPath, configPath } = runtimePaths();
      if (!fs.existsSync(guardPath) || !fs.existsSync(configPath)) return;
      // 避免刚写配置被自己又触发连环写
      if (Date.now() - _lastWriteAt < 5000) return;
      // 空闲不探 · 探活是真实计费请求, 无人对话时不该花钱。
      // 路由不变(保持上次 desired/degraded), 真请求一来即刷活动戳 → 下一 tick 复探。
      if (_isIdle()) {
        if (_lastState !== "idle") {
          _log("[swe-route-guard] idle · 主 session 无活动 · 跳过探活(省费)");
          _lastState = "idle";
        }
        return;
      }

      const guard = _readJson(guardPath);
      const cfg = _readJson(configPath);
      const provider = guard.probeProvider || "terra";
      const model = guard.probeModel || "gpt-5.6-terra";
      const probe = await probeProvider(cfg, provider, model);
      const alive = !!(probe && probe.ok);
      const state = alive ? "alive" : "dead";

      const desired = guard.desired || {};
      const degraded = guard.degraded || {};
      const template = alive ? desired : degraded;

      if (!template || !Object.keys(template).length) return;

      // 强制：glmOnlyUids 始终套 desired 的 fast 定义
      const glmOnly = guard.glmOnlyUids || ["swe-1-6-fast", "MODEL_SWE_1_6_FAST"];
      for (const uid of glmOnly) {
        if (desired[uid]) template[uid] = desired[uid];
      }

      const changed = _applyTemplate(cfg, template);
      if (changed) {
        // terra enabled 保持 true（降级不关渠道，只调优先级）
        if (cfg.providers && cfg.providers[provider]) {
          cfg.providers[provider].enabled = true;
        }
        _lastWriteAt = Date.now();
        _atomicWriteJson(configPath, cfg);
        _log(
          `[swe-route-guard] ${state} · 写路由(${alive ? "desired原路由" : "degraded降级"}) · probe=${probe.reason || probe.status || "?"}`,
        );
      } else if (_lastState !== state) {
        _log(
          `[swe-route-guard] ${state} · 路由已符合目标 · probe=${probe.reason || probe.status || "?"}`,
        );
      }
      _lastState = state;

      // 记录探活状态到 guard 文件（不触发配置热重载环）
      try {
        guard.lastProbe = {
          at: new Date().toISOString(),
          alive,
          reason: probe.reason || String(probe.status || ""),
          body: (probe.body || "").slice(0, 120),
        };
        _atomicWriteJson(guardPath, guard);
      } catch {}
    } catch (e) {
      _log(`[swe-route-guard] tick err: ${e && e.message}`);
    } finally {
      _busy = false;
    }
  })();
}

/**
 * @param {{ log?: function, intervalMs?: number }} opts
 */
function startSweRouteGuard(opts) {
  opts = opts || {};
  if (opts.configPath !== undefined) configure({ configPath: opts.configPath });
  _log = typeof opts.log === "function" ? opts.log : _defaultLog;
  stopSweRouteGuard();
  const { guardPath } = runtimePaths();

  let interval = Number(opts.intervalMs) || 30000;
  try {
    if (fs.existsSync(guardPath)) {
      const g = _readJson(guardPath);
      if (g.probeIntervalMs) interval = Math.max(10000, Number(g.probeIntervalMs) || interval);
    }
  } catch {}

  // 启动后稍等再探，避开启动风暴。句柄保存在 globalThis，热重载后的新模块
  // 也能清理旧模块创建的定时器，避免重复消费探活请求。
  _scheduler.first = setTimeout(() => {
    _scheduler.first = null;
    _tick();
  }, 8000);
  if (_scheduler.first.unref) _scheduler.first.unref();
  _scheduler.interval = setInterval(_tick, interval);
  if (_scheduler.interval.unref) _scheduler.interval.unref();
  _log(`[swe-route-guard] 启 · interval=${interval}ms · guard=${guardPath}`);
  return { intervalMs: interval };
}

function stopSweRouteGuard() {
  if (_scheduler.first) {
    clearTimeout(_scheduler.first);
    _scheduler.first = null;
  }
  if (_scheduler.interval) {
    clearInterval(_scheduler.interval);
    _scheduler.interval = null;
  }
}

/** 供熔断自愈成功时立即恢复 desired（不必等周期） */
function onProviderRecovered(providerName) {
  try {
    const { guardPath, configPath } = runtimePaths();
    if (!fs.existsSync(guardPath)) return false;
    const guard = _readJson(guardPath);
    if ((guard.probeProvider || "terra") !== providerName) return false;
    if (!guard.desired) return false;
    const cfg = _readJson(configPath);
    const changed = _applyTemplate(cfg, guard.desired);
    if (changed) {
      _lastWriteAt = Date.now();
      _atomicWriteJson(configPath, cfg);
      _lastState = "alive";
      _log(`[swe-route-guard] 熔断恢复回调 · 已写回 desired 原路由 · provider=${providerName}`);
    }
    return changed;
  } catch (e) {
    _log(`[swe-route-guard] onProviderRecovered err: ${e && e.message}`);
    return false;
  }
}

module.exports = {
  configure,
  getConfiguredConfigPath,
  runtimePaths,
  startSweRouteGuard,
  stopSweRouteGuard,
  onProviderRecovered,
  probeProvider,
  resolveProviderEndpoint,
  _applyTemplate,
};

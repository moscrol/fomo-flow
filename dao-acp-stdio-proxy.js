#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// dao-acp-stdio-proxy.js · 道 · ACP stdio 中人理 (印22 · 方B)
// ───────────────────────────────────────────────────────────────────────
// 用法: node dao-acp-stdio-proxy.js <devin.exe 路> [原 args...]
//
// 道: 四章「反者道之动也」—— 旧 HTTP MITM 死(Chat 不走 HTTP),
//      故立 stdio 中人: 透传 扩宿 ↔ devin.exe 的 ndJSON ACP 流。
//
// 职责(柔胜强 · 最小不扰):
//   1. spawn 真 devin.exe(承原 args 与 env);
//   2. 双向透传 stdin/stdout/stderr —— ndJSON ACP 字节级不改;
//   3. devin.exe 承 env(含 spawn-hook 注入的 HTTPS_PROXY → dao 由),
//      其 inference 经 dao 由 → 第三方(如 swe-1-6-fast → DeepSeek);
//   4. 子退则父退(码/信号透传) · 父退则子退 —— 无僵尸、无悬挂。
//
// ★ v9.9.346 · 捆绑 ACP 代理 api_server 本地锚定(健康门控自注入) · 根治「Connecting to server」
//   病(实证于 DESKTOP-MASTER): 捆绑 devin.exe(chisel)自持 windsurf_api_client, 绕开 LS 反代
//     直连 WINDSURF_API_SERVER_URL 取 GetCliTeamSettings 鉴权; 官方经系统 VPN 偶发 >3s →
//     "Team settings refresh timed out after 3000ms" → "Failed to authenticate bundled agent"
//     → 前端永卡「Connecting to server」。
//   解: 本中人在 spawn 前探本地反代 /origin/ping, 活则注入 WINDSURF_API_SERVER_URL=本地反代
//     + 把 127.0.0.1 纳入 NO_PROXY(本地反代走明文 h2c·须绕开系统 VPN 代理)→ chisel 即刻本地
//     成帧回真 TeamSettings/ModelConfigs · 无 3s 官方超时 · 与官方可达性彻底解耦。
//   分工: 若上游 spawn-hook(extension.js ≥v9.9.345)已锚 WINDSURF_API_SERVER_URL 则不覆写;
//     本中人乃「已装 v9.9.334 基座免 reload」之兜底锚点(spawn 每次重读本文件即生效)。
//   fail-safe: 仅反代 /ping 200 才注入(与 extension.js _proxyHealthy 同源门控); 探测失败/超时
//     则原样直连官方(反代挂时 chisel→本地口即刻 ECONNREFUSED 亦快于 3s 官方超时·chisel 自有
//     team_settings 磁盘缓存兜底)。五十二章「既得其母 以知其子」· 母=本地兜底 · 子=鉴权态。
//
// 道法自然: 透传即无为,无为而无不为。
// ═══════════════════════════════════════════════════════════════════════
"use strict";

const cp = require("child_process");
const fs = require("fs");
const os = require("node:os");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { Transform } = require("node:stream");
const { createAcpSessionBridge } = require("./acp-session-bridge");
const { resolveAcpModelSessionId } = require("./acp-session-lineage");
const { selectDaoEndpoint } = require("./core/dao_local_endpoint");
const {
  createWorkspaceInputTransform,
  workspaceRootsFromEnv,
} = require("./acp-workspace-message");

const ACP_MODEL_TRACE_FILE = process.env.DAO_ACP_MODEL_TRACE_FILE || "";
const DAO_ACP_MODEL_OPTIONS = [
  ["dao-opus-5", "Dao Opus 5"],
  ["dao-opus-4-8", "Dao Opus 4.8"],
  ["dao-gpt-5-6-sol", "Dao GPT-5.6 Sol"],
  ["dao-gpt-5-6-terra", "Dao GPT-5.6 Terra"],
  ["dao-gpt-5-6-luna", "Dao GPT-5.6 Luna"],
  ["dao-fable-5", "Dao Fable 5"],
  ["dao-glm-5-2", "Dao GLM 5.2"],
  ["dao-mimo-v2-5", "Dao MiMo v2.5"],
].map(([value, name]) => Object.freeze({ value, name }));
const DAO_ACP_MODEL_VALUES = new Set(
  DAO_ACP_MODEL_OPTIONS.map((option) => option.value),
);
const DAO_ACP_FALLBACK_MODEL = "swe-1-6-slow";
const DAO_ACP_MODEL_STATE_FILE =
  process.env.DAO_ACP_MODEL_STATE_FILE ||
  require("node:path").join(
    require("node:os").homedir(),
    ".local",
    "share",
    "devin",
    "cli",
    "dao-acp-model-selection.json",
  );
const daoModelBySession = new Map();
const pendingDaoModelSelections = new Map();
const pendingAcpSessionStarts = new Set();
let activeAcpSessionId = "";
let activeAcpModelSessionId = "";

try {
  const saved = JSON.parse(fs.readFileSync(DAO_ACP_MODEL_STATE_FILE, "utf8"));
  if (saved && saved.sessions && typeof saved.sessions === "object") {
    for (const [sessionId, model] of Object.entries(saved.sessions)) {
      if (DAO_ACP_MODEL_VALUES.has(model))
        daoModelBySession.set(sessionId, model);
    }
  }
} catch (_) {}

function sessionKey(sessionId) {
  return typeof sessionId === "string" && sessionId ? sessionId : "";
}

function setActiveAcpSessionId(sessionId) {
  const key = sessionKey(sessionId);
  if (!key) return;
  activeAcpSessionId = key;
  activeAcpModelSessionId = resolveAcpModelSessionId(key) || key;
}

function persistDaoModelSelection(sessionId, model) {
  const key = sessionKey(sessionId);
  if (!key) return;
  try {
    const saved = JSON.parse(fs.readFileSync(DAO_ACP_MODEL_STATE_FILE, "utf8"));
    if (saved && saved.sessions && typeof saved.sessions === "object") {
      for (const [savedSessionId, savedModel] of Object.entries(
        saved.sessions,
      )) {
        if (DAO_ACP_MODEL_VALUES.has(savedModel)) {
          daoModelBySession.set(savedSessionId, savedModel);
        }
      }
    }
  } catch (_) {}
  if (DAO_ACP_MODEL_VALUES.has(model)) daoModelBySession.set(key, model);
  else daoModelBySession.delete(key);
  try {
    const directory = require("node:path").dirname(DAO_ACP_MODEL_STATE_FILE);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryFile = `${DAO_ACP_MODEL_STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporaryFile,
      JSON.stringify({
        sessions: Object.fromEntries(daoModelBySession),
        updatedAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    fs.renameSync(temporaryFile, DAO_ACP_MODEL_STATE_FILE);
  } catch (_) {}
}

function selectedDaoModel(sessionId) {
  return daoModelBySession.get(sessionKey(sessionId)) || "";
}

function rewriteDaoModelSelectionLine(line) {
  if (
    !line ||
    (!line.includes("session/set_config_option") &&
      !line.includes("session/set_model"))
  ) {
    return { line, changed: false };
  }
  try {
    const message = JSON.parse(line);
    const params = message && message.params;
    const isConfigModelSelection =
      message.method === "session/set_config_option" &&
      params &&
      params.configId === "model" &&
      typeof params.value === "string";
    const isNativeModelSelection =
      message.method === "session/set_model" &&
      params &&
      typeof params.modelId === "string";
    if (!isConfigModelSelection && !isNativeModelSelection) {
      return { line, changed: false };
    }
    const sessionId = sessionKey(params.sessionId);
    if (!sessionId) return { line, changed: false };
    const model = isConfigModelSelection ? params.value : params.modelId;
    if (DAO_ACP_MODEL_VALUES.has(model)) {
      pendingDaoModelSelections.set(String(message.id), { model, sessionId });
      persistDaoModelSelection(sessionId, model);
      if (isConfigModelSelection) params.value = DAO_ACP_FALLBACK_MODEL;
      else params.modelId = DAO_ACP_FALLBACK_MODEL;
      return { line: JSON.stringify(message), changed: true };
    }
    pendingDaoModelSelections.delete(String(message.id));
    persistDaoModelSelection(sessionId, "");
  } catch (_) {}
  return { line, changed: false };
}

function restoreDaoModelSelectionLine(line) {
  if (!line || !pendingDaoModelSelections.size) {
    return { line, changed: false };
  }
  try {
    const message = JSON.parse(line);
    const selection = pendingDaoModelSelections.get(String(message.id));
    if (!selection || !message.result || typeof message.result !== "object") {
      return { line, changed: false };
    }
    pendingDaoModelSelections.delete(String(message.id));
    const result = message.result;
    const configOptions = Array.isArray(result.configOptions)
      ? result.configOptions.map((option) => {
          if (!option || option.category !== "model") return option;
          const restored = { ...option, currentValue: selection.model };
          if (
            option.value &&
            typeof option.value === "object" &&
            !Array.isArray(option.value)
          ) {
            restored.value = { ...option.value, currentValue: selection.model };
          }
          return restored;
        })
      : result.configOptions;
    const models =
      result.models && typeof result.models === "object"
        ? { ...result.models, currentModelId: selection.model }
        : result.models;
    return {
      line: JSON.stringify({
        ...message,
        result: { ...result, configOptions, models },
      }),
      changed: true,
    };
  } catch (_) {
    return { line, changed: false };
  }
}

function injectDaoModelConfigOptions(line, sessionId) {
  if (!line) return line;
  try {
    const restored = restoreDaoModelSelectionLine(line);
    const restoredLine = restored.changed ? restored.line : line;
    const message = JSON.parse(restoredLine);
    // Agent-initiated session/update notifications carry config in
    // params.update (not result) and their own sessionId for attribution.
    // Without this path the agent echoes the rewritten mount model
    // (swe-1-6-slow) back to the UI and the picker visibly "downgrades".
    const isConfigOptionUpdateNotification =
      message &&
      message.method === "session/update" &&
      message.params &&
      message.params.update &&
      message.params.update.sessionUpdate === "config_option_update";
    const result = isConfigOptionUpdateNotification
      ? message.params.update
      : message && message.result;
    const activeDaoModel = selectedDaoModel(
      isConfigOptionUpdateNotification
        ? sessionKey(message.params.sessionId)
        : sessionId,
    );
    if (!result || typeof result !== "object") return restoredLine;
    let changed = false;
    const configOptions = Array.isArray(result.configOptions)
      ? result.configOptions.map((option) => {
      if (!option || option.category !== "model") return option;
      const options = Array.isArray(option.options) ? option.options : [];
      const hasDaoGroup = options.some(
        (group) =>
          group &&
          typeof group === "object" &&
          (group.group === "dao-flow" ||
            (Array.isArray(group.options) &&
              group.options.some(
                (choice) =>
                  choice &&
                  typeof choice.value === "string" &&
                  choice.value.startsWith("dao-"),
              ))),
      );
      const daoOptions = [
        ...options,
        ...DAO_ACP_MODEL_OPTIONS.map((choice) => ({
          group: choice.value,
          name: choice.name,
          options: [choice],
        })),
      ];
      const hasNestedValue =
        option.value &&
        typeof option.value === "object" &&
        !Array.isArray(option.value);
      const needsCurrentValue =
        Boolean(activeDaoModel) &&
        (option.currentValue !== activeDaoModel ||
          (hasNestedValue && option.value.currentValue !== activeDaoModel));
      if (hasDaoGroup) {
        if (!needsCurrentValue) return option;
        changed = true;
        return hasNestedValue
          ? {
              ...option,
              currentValue: activeDaoModel,
              value: { ...option.value, currentValue: activeDaoModel },
            }
          : { ...option, currentValue: activeDaoModel };
      }
      changed = true;
      return hasNestedValue
        ? {
            ...option,
            ...(activeDaoModel ? { currentValue: activeDaoModel } : {}),
            options: daoOptions,
            value: {
              ...option.value,
              currentValue: activeDaoModel || option.value.currentValue,
              options: daoOptions,
            },
          }
        : {
            ...option,
            ...(activeDaoModel ? { currentValue: activeDaoModel } : {}),
            options: daoOptions,
          };
        })
      : result.configOptions;
    const models =
      result.models &&
      typeof result.models === "object" &&
      Array.isArray(result.models.availableModels)
        ? {
            ...result.models,
            ...(activeDaoModel
              ? { currentModelId: activeDaoModel }
              : {}),
            availableModels: [
              ...result.models.availableModels,
              ...DAO_ACP_MODEL_OPTIONS.filter(
                (choice) =>
                  !result.models.availableModels.some(
                    (model) => model && model.modelId === choice.value,
                  ),
              ).map((choice) => ({
                modelId: choice.value,
                name: choice.name,
              })),
            ],
          }
        : result.models;
    if (models !== result.models) changed = true;
    if (!changed) return restoredLine;
    const updatedPayload = { ...result, configOptions, models };
    return JSON.stringify(
      isConfigOptionUpdateNotification
        ? {
            ...message,
            params: { ...message.params, update: updatedPayload },
          }
        : { ...message, result: updatedPayload },
    );
  } catch (_) {
    return line;
  }
}

function writeModelTraceLine(line) {
  if (!ACP_MODEL_TRACE_FILE || !line) return;
  try {
    const message = JSON.parse(line);
    const result = message && message.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const models = result.models;
    const modelConfigOptions = Array.isArray(result.configOptions)
      ? result.configOptions
          .filter((option) => option && option.category === "model")
          .map((option) => ({
            id: option.id,
            ...(typeof option.name === "string" ? { name: option.name } : {}),
            currentValue:
              typeof option.currentValue === "string"
                ? option.currentValue
                : "",
            options: Array.isArray(option.options)
              ? option.options.map((group) => ({
                  ...(typeof group.group === "string"
                    ? { group: group.group }
                    : {}),
                  ...(typeof group.name === "string"
                    ? { name: group.name }
                    : {}),
                  options: Array.isArray(group.options)
                    ? group.options
                        .filter(
                          (choice) =>
                            choice && typeof choice.value === "string",
                        )
                        .map((choice) => ({
                          value: choice.value,
                          ...(typeof choice.name === "string"
                            ? { name: choice.name }
                            : {}),
                        }))
                    : [],
                }))
              : [],
          }))
      : [];
    if (
      (!models || !Array.isArray(models.availableModels)) &&
      !modelConfigOptions.length
    ) {
      return;
    }
    const record = {
      resultKeys: Object.keys(result).sort(),
      ...(models && Array.isArray(models.availableModels)
        ? {
            currentModelId:
              typeof models.currentModelId === "string"
                ? models.currentModelId
                : "",
            availableModels: models.availableModels
              .filter((model) => model && typeof model.modelId === "string")
              .map((model) => ({
                modelId: model.modelId,
                ...(typeof model.name === "string" ? { name: model.name } : {}),
                ...(typeof model.description === "string"
                  ? { description: model.description }
                  : {}),
              })),
          }
        : {}),
      ...(modelConfigOptions.length ? { modelConfigOptions } : {}),
    };
    fs.appendFileSync(ACP_MODEL_TRACE_FILE, JSON.stringify(record) + "\n");
  } catch (_) {
    // Tracing must never affect the ACP transport.
  }
}

function rememberSessionRequest(line, requestSessions) {
  try {
    const message = JSON.parse(line);
    const sessionId = sessionKey(
      message && message.params && message.params.sessionId,
    );
    if (message && message.method === "session/new" && message.id != null) {
      pendingAcpSessionStarts.add(String(message.id));
    }
    if (sessionId && message && message.id != null) {
      // Summary agents must never inherit the main session's model route —
      // their bridge getSessionId returns empty, and their config responses
      // must not carry a Dao model currentValue either.
      if (!isSummaryAgent) {
        // The bridge has one process-local identity. Control-plane requests can
        // interleave across sessions, so they must not steal an active inference
        // route. A prompt selects the route; a first request may initialize it.
        if (
          message.method === "session/prompt" ||
          (!activeAcpSessionId &&
            message.method !== "session/get_config_options")
        ) {
          setActiveAcpSessionId(sessionId);
        }
        // Record main-session activity for summary cooldown — only on genuine
        // user turns. Agentic tool-result continuations also use session/prompt
        // but carry prompt entries with role "tool", not "user"/"human". Counting
        // those would reset the 5-minute timer for as long as Devin runs a task,
        // making the cooldown gate permanently unreachable.
        if (message.method === "session/prompt" && hasUserPromptTurn(message)) {
          touchSummaryActivity();
        }
        requestSessions.set(String(message.id), sessionId);
      }
    }
  } catch (_) {}
  return { line, changed: false };
}

function rememberStartedAcpSession(line) {
  try {
    const message = JSON.parse(line);
    const requestId = message && message.id != null ? String(message.id) : "";
    if (!requestId || !pendingAcpSessionStarts.delete(requestId)) return;
    const sessionId = sessionKey(
      message && message.result && message.result.sessionId,
    );
    if (sessionId) setActiveAcpSessionId(sessionId);
  } catch (_) {}
}

// Attribute a response to the ACP session whose model selection it must show.
// Two sources, in order of authority:
//   1. requestSessions — request id → params.sessionId (config reads, prompts).
//   2. result.sessionId — session/new and resume carry the id ONLY here; their
//      request params have none. Without this the config options that ride
//      along with a fresh session cannot be attributed, so the selector falls
//      back to Devin's own mount model (swe-1-6-slow) on every new session.
function attributeResponseSession(line, requestSessions) {
  if (isSummaryAgent) return "";
  let sessionId = "";
  try {
    const response = JSON.parse(line);
    if (response && response.id != null) {
      sessionId = requestSessions.get(String(response.id)) || "";
      requestSessions.delete(String(response.id));
    }
    const startedSessionId = sessionKey(
      response && response.result && response.result.sessionId,
    );
    if (startedSessionId) sessionId = startedSessionId;
  } catch (_) {}
  return sessionId;
}

function createModelTraceTransform(requestSessions) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  function transformPending(flush) {
    let output = "";
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const rawLine = pending.slice(0, index);
      pending = pending.slice(index + 1);
      const hasCarriageReturn = rawLine.endsWith("\r");
      const line = hasCarriageReturn ? rawLine.slice(0, -1) : rawLine;
      const responseSessionId = attributeResponseSession(line, requestSessions);
      rememberStartedAcpSession(line);
      const transformed = injectDaoModelConfigOptions(line, responseSessionId);
      writeModelTraceLine(transformed);
      output += transformed + (hasCarriageReturn ? "\r\n" : "\n");
    }
    if (flush && pending) {
      const responseSessionId = attributeResponseSession(
        pending,
        requestSessions,
      );
      rememberStartedAcpSession(pending);
      const transformed = injectDaoModelConfigOptions(
        pending,
        responseSessionId,
      );
      writeModelTraceLine(transformed);
      output += transformed;
      pending = "";
    }
    return output;
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk);
      callback(null, transformPending(false));
    },
    flush(callback) {
      pending += decoder.end();
      callback(null, transformPending(true));
    },
  });
}

const argv = process.argv.slice(2);
if (argv.length < 1) {
  process.stderr.write("[dao-acp-stdio-proxy] missing devin.exe path\n");
  process.exit(2);
}

const target = argv[0];
const targetArgs = argv.slice(1);

// 摘要代理 (--agent-type summarizer) 只生成对话标题/摘要, 不需要继承主 session
// 的昂贵 Dao 模型。让它走 swe-1-6-slow 默认降级链 (由 配置.json channelPriority 决定),
// 或通过 DAO_ACP_SUMMARY_MODEL 指定更便宜模型。
const isSummaryAgent = targetArgs.some(
  (arg, i) => arg === "--agent-type" && targetArgs[i + 1] === "summarizer",
);

// ── 推理冷却: 主 session 超过 5 分钟无 session/prompt 活动则不再转发推理请求 ──
// 适用于所有 proxy（主 session + summarizer），因为 Devin "停止" 不杀子进程，
// 后台标题/摘要生成器继续通过主 session 的 HTTP/2 bridge 发 GetChatMessage。
const SUMMARY_COOLDOWN_MS =
  parseInt(String(process.env.DAO_ACP_SUMMARY_COOLDOWN_MS || ""), 10) || 300000; // 5 min
const SUMMARY_ACTIVITY_FILE =
  process.env.DAO_ACP_SUMMARY_ACTIVITY_FILE ||
  require("node:path").join(
    require("node:os").homedir(),
    ".local",
    "share",
    "devin",
    "cli",
    "dao-acp-summary-activity.json",
  );

// Returns true when the session/prompt message contains at least one entry
// with role "user" or "human" — i.e. a genuine user-initiated turn.
// Empty prompt arrays and tool-result arrays both return false.
function hasUserPromptTurn(message) {
  const prompt = message && message.params && message.params.prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) return false;
  return prompt.some(
    (entry) => entry && (entry.role === "user" || entry.role === "human"),
  );
}

function touchSummaryActivity() {
  try {
    fs.mkdirSync(require("node:path").dirname(SUMMARY_ACTIVITY_FILE), {
      recursive: true,
    });
    fs.writeFileSync(
      SUMMARY_ACTIVITY_FILE,
      JSON.stringify({ lastActiveAt: Date.now() }),
      { mode: 0o600 },
    );
  } catch (_) {}
}

function isSummaryCold() {
  // Summarizer proxy: no readable activity record means no recorded
  // main-session activity — defaulting to "hot" would make the gate
  // unreachable. Never-active → cold.
  let lastActiveAt = 0;
  try {
    const data = JSON.parse(fs.readFileSync(SUMMARY_ACTIVITY_FILE, "utf8"));
    const parsed = Number(data && data.lastActiveAt);
    if (Number.isFinite(parsed) && parsed > 0) lastActiveAt = parsed;
  } catch (_) {}
  return Date.now() - lastActiveAt > SUMMARY_COOLDOWN_MS;
}

function isMainSessionCold() {
  // Main session proxy: only block if there WAS activity that then went stale.
  // A never-active main session is "just started", not "stopped and leaking".
  let lastActiveAt = 0;
  try {
    const data = JSON.parse(fs.readFileSync(SUMMARY_ACTIVITY_FILE, "utf8"));
    const parsed = Number(data && data.lastActiveAt);
    if (Number.isFinite(parsed) && parsed > 0) lastActiveAt = parsed;
  } catch (_) {}
  return lastActiveAt > 0 && Date.now() - lastActiveAt > SUMMARY_COOLDOWN_MS;
}

// 冷却只该省掉「推理」这一笔钱。鉴权/座席/团队设置同走 h2c 面, 一并拦则
// devin.exe 取 GetCliTeamSettings 无应答 → "fetch timed out after 10000ms"
// → "Failed to activate agent Devin Local"。故按 RPC 名精确圈定推理。
// 与网关 classifyRPC 同源(source.js: CHAT_PROTO / CHAT_RAW)。
const SUMMARY_INFERENCE_RPCS = new Set([
  "GetChatMessage",
  "GetChatMessageV2",
  "RawGetChatMessage",
]);

function isInferenceRpcPath(requestPath) {
  if (typeof requestPath !== "string" || !requestPath) return false;
  const queryIndex = requestPath.indexOf("?");
  const cleanPath =
    queryIndex < 0 ? requestPath : requestPath.slice(0, queryIndex);
  const match = /\/([A-Za-z0-9_]+)$/.exec(cleanPath);
  return match ? SUMMARY_INFERENCE_RPCS.has(match[1]) : false;
}

function shouldBlockSummaryRequest(requestPath) {
  if (!isInferenceRpcPath(requestPath)) return false;
  return isSummaryAgent ? isSummaryCold() : isMainSessionCold();
}

// devin.exe 承之 env(可被本中人健康门控锚定 api_server)
const childEnv = Object.assign({}, process.env);
const DEFAULT_PROXY_URL = "http://127.0.0.1:8937";
const DESKTOP_ENDPOINT_FILE =
  process.env.DAO_DESKTOP_ENDPOINT_FILE ||
  path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "dao-flow-desktop",
    "runtime",
    "endpoint.json",
  );
let selectedProxyUrl = process.env.DAO_ACP_API_URL || "";

// ── spawn 前缓冲 stdin(保序·字节不改) · 待健康探测毕再落子并回放 ──
const _pre = [];
let _child = null;
let _childInput = null;
let _flushed = false;
let _stdinEnded = false;
process.stdin.on("data", (chunk) => {
  if (_child && _flushed) {
    try {
      _childInput.write(chunk);
    } catch (_) {
      /* noop */
    }
  } else {
    _pre.push(chunk);
  }
});
// 宿主亡则中人亡: stdin EOF/断裂 = 扩宿已逝(Reload Window 等), 限时收割子进程后自退,
// 免孤儿 devin acp 长持 session lock("already open in another process")。
let _orphanTimer = null;
function reapAndExit() {
  if (_orphanTimer) return;
  _orphanTimer = setTimeout(() => {
    try {
      if (_child) _child.kill();
    } catch (_) {
      /* noop */
    }
    setTimeout(() => process.exit(0), 1500);
  }, 2000);
}
process.stdin.on("end", () => {
  _stdinEnded = true;
  if (_child && _flushed) {
    try {
      _childInput.end();
    } catch (_) {
      /* noop */
    }
  }
  reapAndExit();
});
process.stdin.on("close", reapAndExit);
process.stdin.on("error", reapAndExit);

async function launch() {
  let sessionBridge = null;
  try {
    const upstreamUrl =
      selectedProxyUrl || childEnv.WINDSURF_API_SERVER_URL || DEFAULT_PROXY_URL;
    sessionBridge = createAcpSessionBridge({
      upstreamUrl,
      getSessionId: () => {
        // Summary agents: no session header (cost isolation), plus check
        // cooldown — if main session idle >5min, don't forward at all.
        if (isSummaryAgent) return "";
        return activeAcpModelSessionId || activeAcpSessionId;
      },
      // 冷却闸门适用于所有 proxy（主 session + summarizer）。
      // 主 session 的 "停止" 不杀子进程，后台标题/摘要生成器继续发推理
      // RPC；不加闸门则这些请求直透上游，冷却形同虚设。
      shouldBlock: shouldBlockSummaryRequest,
    });
    const bridgePort = await sessionBridge.start();
    childEnv.WINDSURF_API_SERVER_URL = `http://127.0.0.1:${bridgePort}`;
  } catch (error) {
    sessionBridge = null;
    process.stderr.write(
      "[dao-acp-stdio-proxy] session bridge unavailable: " +
        (error && error.message ? error.message : String(error)) +
        "\n",
    );
  }

  let child;
  try {
    child = cp.spawn(target, targetArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv, // 承 spawn-hook 注入的 HTTPS_PROXY/ACP_BACKEND + 本中人锚定的 api_server
      windowsHide: true,
    });
  } catch (err) {
    if (sessionBridge) sessionBridge.close().catch(() => {});
    process.stderr.write(
      "[dao-acp-stdio-proxy] spawn failed: " + (err && err.message) + "\n",
    );
    process.exit(1);
  }
  _child = child;

  const workspaceRoots = workspaceRootsFromEnv(childEnv);
  // Always inspect session/new. Devin may provide a valid cwd while the
  // extension host exposes no workspaceFolders; the transform infers roots
  // from that ACP message and registers them for Cortex search.
  const requestSessions = new Map();
  _childInput = createWorkspaceInputTransform(
    workspaceRoots,
    (result) => {
      if (!result.cwd) return;
      process.stderr.write(
        `[dao-acp-stdio-proxy] workspace registered cwd=${result.cwd} roots=${1 + result.additionalDirectories.length}\n`,
      );
    },
    childEnv.WINDSURF_API_SERVER_URL || selectedProxyUrl || DEFAULT_PROXY_URL,
    (line) => {
      rememberSessionRequest(line, requestSessions);
      return rewriteDaoModelSelectionLine(line);
    },
  );
  if (_childInput !== child.stdin) _childInput.pipe(child.stdin);

  // 回放 spawn 前缓冲的 stdin, 尔后转入直写(保序)
  for (let i = 0; i < _pre.length; i++) {
    try {
      _childInput.write(_pre[i]);
    } catch (_) {
      /* noop */
    }
  }
  _pre.length = 0;
  _flushed = true;
  if (_stdinEnded) {
    try {
      _childInput.end();
    } catch (_) {
      /* noop */
    }
  }

  // ── 出向透传(字节级 · 不改 ndJSON) ──
  child.stdout
    .pipe(createModelTraceTransform(requestSessions))
    .pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  // ── EPIPE/destroyed 静默(对端先关属常态) ──
  const _silence = (s) => {
    if (s && typeof s.on === "function") s.on("error", () => {});
  };
  _silence(process.stdin);
  _silence(process.stdout);
  _silence(process.stderr);
  _silence(child.stdin);
  _silence(child.stdout);
  _silence(child.stderr);

  // ── 生命周期 ──
  const closeSessionBridge = () => {
    if (!sessionBridge) return;
    const bridge = sessionBridge;
    sessionBridge = null;
    bridge.close().catch(() => {});
  };
  child.on("error", (err) => {
    closeSessionBridge();
    process.stderr.write(
      "[dao-acp-stdio-proxy] child error: " + (err && err.message) + "\n",
    );
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    closeSessionBridge();
    if (signal) {
      try {
        process.kill(process.pid, signal);
        return;
      } catch (_) {
        /* fallthrough */
      }
    }
    process.exit(code == null ? 0 : code);
  });
  const _killChild = () => {
    closeSessionBridge();
    try {
      child.kill();
    } catch (_) {
      /* noop */
    }
  };
  process.on("SIGTERM", _killChild);
  process.on("SIGINT", _killChild);
  process.on("SIGHUP", _killChild);
  process.on("exit", _killChild);
}

// ── 健康门控自注入(仅反代活时锚定 · 失败安全直连官方) ──
function anchorApiEnv(proxyUrl) {
  childEnv.WINDSURF_API_SERVER_URL = proxyUrl;
  const _np = childEnv.NO_PROXY || childEnv.no_proxy || "";
  if (!/127\.0\.0\.1/.test(_np)) {
    const _merged = _np
      ? _np + ",127.0.0.1,localhost,::1"
      : "127.0.0.1,localhost,::1";
    childEnv.NO_PROXY = _merged;
    childEnv.no_proxy = _merged;
  }
}

async function probeThenLaunch() {
  const discovered = await selectDaoEndpoint({
    explicitUrl: process.env.DAO_ACP_API_URL || "",
    desktopDescriptorPath: DESKTOP_ENDPOINT_FILE,
    inheritedUrl: "",
    fallbackUrl: "",
  });
  if (discovered) {
    selectedProxyUrl = discovered;
    anchorApiEnv(discovered);
  }
  await launch();
}

void probeThenLaunch();

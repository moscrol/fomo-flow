#!/usr/bin/env node
"use strict";
/**
 * dao-acp-proxy.js · dao-flow 作为 P/ACP 中间人 (监测·运维·增益·不执行工具)
 * ───────────────────────────────────────────────────────────────
 * 坐在编辑器(ACP client)与真实 ACP agent 之间, 透明转发双向 ndJSON ACP 流,
 * 只在出站 session/prompt 做增益(脱敏/注入)并对双向做监测; 工具调用/权限请求
 * /session/update 一律原样透传 —— 执行归真 agent, dao-flow 只经手不越位。
 *
 * 用法(在宿主的 agent_servers 里, 把原本指向真 agent 的命令包一层):
 *   node <repo>/scripts/dao-acp-proxy.js -- <real-agent-cmd> [args...]
 *   例: node scripts/dao-acp-proxy.js -- claude-code-acp
 *
 * 环境变量:
 *   DAO_ACP_PROXY_REDACT=1            出站 prompt 脱敏 (默认关)
 *   DAO_ACP_PROXY_REDACT_MODE=redact  monitor|redact|block (默认 redact)
 *   DAO_ACP_PROXY_INJECT="..."        出站 prompt 前缀注入 (默认无)
 *   DAO_ACP_PROXY_STAGES="inject,redact,monitor"  增益阶段链顺序/启停 (省略某项即停用; 默认先注入再脱敏)
 *   DAO_ACP_PROXY_MAX_PROMPT_CHARS=<n>  运维守卫: 出站 prompt 字符上限 (超则拦并回 refusal)
 *   DAO_ACP_PROXY_MAX_PROMPTS_PER_MIN=<n>  运维守卫: 每会话每分钟 prompt 上限
 *   DAO_ACP_PROXY_MAX_BLOCK_CHARS=<n>   运维守卫: 单个 text/resource 块字符上限
 *   DAO_ACP_PROXY_MAX_PROMPT_BLOCKS=<n> 运维守卫: 单条 prompt 内容块数上限
 *   DAO_ACP_PROXY_INJECT_DETECT=1       出站注入话术监测 (默认关)
 *   DAO_ACP_PROXY_INJECT_DETECT_MODE=monitor  monitor|block (默认 monitor 只报不拦)
 *   DAO_ACP_PROXY_LOG=<path>          监测事件 JSONL 落盘 (默认 stderr)
 *   DAO_ACP_OTEL_ENDPOINT=<url>       ACP 每轮 trace 导出到 OTLP (否则读 配置.json otel)
 */

const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stateFile } = require(path.join(__dirname, "..", "core", "product_identity.js"));
const CORE = path.join(__dirname, "..", "vendor", "外接api", "core");
const { createAcpProxy } = require(path.join(CORE, "acp_proxy.js"));
const { createAugmentation } = require(path.join(CORE, "acp_augment.js"));
const { createAcpMonitor } = require(path.join(CORE, "acp_monitor.js"));

// ── OTEL 导出(代理进程自带 · ACP 每轮对话作为 span 流入 OTLP 后端) ──
//   配置来源: env(DAO_ACP_OTEL_ENDPOINT) 优先, 否则读 dao 配置.json 的 otel 段。
function resolveOtel() {
  const envEndpoint = String(process.env.DAO_ACP_OTEL_ENDPOINT || "").trim();
  if (envEndpoint) {
    return { enabled: true, endpoint: envEndpoint, serviceName: process.env.DAO_ACP_OTEL_SERVICE || "fomo-flow-acp" };
  }
  try {
    const cfgPath = stateFile("配置.json") || path.join(os.homedir() || "", ".fomo-flow", "配置.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const otel = cfg && cfg.otel;
    if (otel && otel.enabled === true && otel.endpoint) {
      return { enabled: true, endpoint: otel.endpoint, serviceName: (otel.serviceName || "fomo-flow") + "-acp" };
    }
  } catch (_) {}
  return { enabled: false };
}

function createOtelSink() {
  const conf = resolveOtel();
  if (!conf.enabled) return null;
  let exporter;
  try {
    const { createOtelExporter } = require(path.join(CORE, "otel_export.js"));
    const http = require("node:http");
    const https = require("node:https");
    exporter = createOtelExporter({
      endpoint: conf.endpoint,
      serviceName: conf.serviceName,
      httpPost: (urlStr, headers, body) =>
        new Promise((resolve, reject) => {
          try {
            const url = new URL(urlStr);
            const mod = url.protocol === "https:" ? https : http;
            const payload = Buffer.from(body, "utf8");
            const req = mod.request(url, { method: "POST", headers: { ...headers, "Content-Length": payload.length }, timeout: 8000 }, (resp) => {
              resp.on("data", () => {});
              resp.on("end", () => (resp.statusCode >= 200 && resp.statusCode < 300 ? resolve() : reject(new Error("OTLP HTTP " + resp.statusCode))));
            });
            req.on("error", reject);
            req.on("timeout", () => { try { req.destroy(); } catch (_) {} reject(new Error("OTLP timeout")); });
            req.end(payload);
          } catch (e) { reject(e); }
        }),
      log: (m) => process.stderr.write("[dao-acp-proxy] " + m + "\n"),
    });
  } catch (_) {
    return null;
  }
  process.on("exit", () => { try { exporter.flush(); } catch (_) {} });
  return exporter;
}

const argv = process.argv.slice(2);
const dashDash = argv.indexOf("--");
const downstream =
  dashDash >= 0 ? argv.slice(dashDash + 1) : argv.filter((a) => a !== "--");
if (downstream.length < 1) {
  process.stderr.write(
    "[dao-acp-proxy] 缺少下游 agent 命令。用法: dao-acp-proxy.js -- <agent-cmd> [args...]\n",
  );
  process.exit(2);
}

const LOG_PATH = process.env.DAO_ACP_PROXY_LOG || "";
const otelSink = createOtelSink();
const acpMonitor = createAcpMonitor({
  onTrace: (trace) => { if (otelSink) otelSink.exportTrace(trace); },
});
function jsonlLog(event) {
  const line = JSON.stringify({ at: Date.now(), ...event }) + "\n";
  if (LOG_PATH) {
    try {
      fs.appendFileSync(LOG_PATH, line);
      return;
    } catch (_) {}
  }
  process.stderr.write("[dao-acp-proxy] " + line);
}
// 监测事件: 落 JSONL(审计/运维) + 汇成每轮 trace 交 OTEL(可观测栈)
function monitor(event) {
  jsonlLog(event);
  try { acpMonitor.handleEvent(event); } catch (_) {}
}

const _stagesEnv = String(process.env.DAO_ACP_PROXY_STAGES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const _guardCfg = {};
if (Number(process.env.DAO_ACP_PROXY_MAX_PROMPT_CHARS) > 0)
  _guardCfg.maxPromptChars = Number(process.env.DAO_ACP_PROXY_MAX_PROMPT_CHARS);
if (Number(process.env.DAO_ACP_PROXY_MAX_PROMPTS_PER_MIN) > 0)
  _guardCfg.maxPromptsPerMin = Number(process.env.DAO_ACP_PROXY_MAX_PROMPTS_PER_MIN);
if (Number(process.env.DAO_ACP_PROXY_MAX_BLOCK_CHARS) > 0)
  _guardCfg.maxBlockChars = Number(process.env.DAO_ACP_PROXY_MAX_BLOCK_CHARS);
if (Number(process.env.DAO_ACP_PROXY_MAX_PROMPT_BLOCKS) > 0)
  _guardCfg.maxPromptBlocks = Number(process.env.DAO_ACP_PROXY_MAX_PROMPT_BLOCKS);
const augment = createAugmentation({
  redact: process.env.DAO_ACP_PROXY_REDACT === "1",
  redactMode: process.env.DAO_ACP_PROXY_REDACT_MODE || "redact",
  injectPrefix: process.env.DAO_ACP_PROXY_INJECT || "",
  injectDetect:
    process.env.DAO_ACP_PROXY_INJECT_DETECT === "1"
      ? { mode: process.env.DAO_ACP_PROXY_INJECT_DETECT_MODE || "monitor" }
      : undefined,
  guard: Object.keys(_guardCfg).length ? _guardCfg : undefined,
  stages: _stagesEnv.length ? _stagesEnv : undefined, // 空=默认 inject,redact,monitor
  onMonitor: monitor,
});

const child = cp.spawn(downstream[0], downstream.slice(1), {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
  windowsHide: true,
});

const proxy = createAcpProxy({
  editorIn: process.stdin,
  editorOut: process.stdout,
  agentIn: child.stdin,
  agentOut: child.stdout,
  transformOutbound: augment.transformOutbound,
  transformInbound: augment.transformInbound,
  onEvent: monitor,
  onEnd: (direction) => {
    // 编辑器断开(stdin end) → 收割下游; 下游断开 → 随之退出
    if (direction === "outbound") {
      try { child.stdin.end(); } catch (_) {}
    }
  },
});
proxy.start();

child.on("exit", (code, signal) => {
  monitor({ type: "downstream_exit", code, signal });
  if (signal) {
    try { process.kill(process.pid, signal); return; } catch (_) {}
  }
  process.exit(code == null ? 0 : code);
});
child.on("error", (e) => {
  process.stderr.write("[dao-acp-proxy] 下游启动失败: " + (e && e.message) + "\n");
  process.exit(1);
});
const killChild = () => { try { child.kill(); } catch (_) {} };
process.on("SIGTERM", killChild);
process.on("SIGINT", killChild);
process.on("SIGHUP", killChild);
process.on("exit", killChild);
process.stdin.on("end", () => {
  setTimeout(() => { killChild(); setTimeout(() => process.exit(0), 1000); }, 1500);
});
process.stdin.resume();

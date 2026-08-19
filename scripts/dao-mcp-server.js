#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// dao-mcp-server.js · 桌子 MCP 工具服务 (stdio · 零依赖)
// ───────────────────────────────────────────────────────────────────────
// 把桌子的运维动作封装为 Agent 可调用的 MCP tools:
//   在 Cascade/Claude/任意 MCP 客户端里直接问「昨晚哪个渠道挂了」「回滚配置」
//
// 用法 (MCP 客户端配置):
//   { "command": "node", "args": ["<repo>/scripts/dao-mcp-server.js"] }
// 端口发现: env DAO_ORIGIN_PORT → ~/.dao/origin-port.json → 8889
//
// 协议: MCP over stdio (JSON-RPC 2.0 · Content-Length 无框架 · 行分隔 ndJSON)
// ═══════════════════════════════════════════════════════════════════════
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

function resolvePort() {
  const envPort = parseInt(process.env.DAO_ORIGIN_PORT || "", 10);
  if (envPort > 0) return envPort;
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".dao", "origin-port.json"), "utf8"),
    );
    if (j && j.port > 0) return j.port;
  } catch {}
  return 8889;
}

function callProxy(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: resolvePort(),
        path: pathname,
        method,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve({ ok: false, error: `non-JSON response: ${text.slice(0, 200)}` });
          }
        });
      },
    );
    req.on("error", (e) => reject(new Error(`桌子代理不可达 (${e.message}) · 确认 VSIX 已启动`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("桌子代理请求超时"));
    });
    if (data) req.write(data);
    req.end();
  });
}

const TOOLS = [
  {
    name: "dao_status",
    description: "查看桌子路由状态与渠道健康 (哪些渠道在线/熔断)",
    inputSchema: { type: "object", properties: {} },
    run: () => callProxy("GET", "/origin/ea/status"),
  },
  {
    name: "dao_usage",
    description: "查看各渠道/模型的用量聚合 (tokens、缓存命中率、估算花费)",
    inputSchema: { type: "object", properties: {} },
    run: () => callProxy("GET", "/origin/ea/usage"),
  },
  {
    name: "dao_alerts",
    description: "查看最近告警 (渠道熔断/全路由失败/预算超限)。可传 since 增量拉取",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "只返回此告警 id 之后的 (可选)" },
        limit: { type: "number", description: "条数上限 · 默认 50" },
      },
    },
    run: (args) =>
      callProxy(
        "GET",
        `/origin/ea/alerts?since=${Number(args.since) || 0}&limit=${Number(args.limit) || 50}`,
      ),
  },
  {
    name: "dao_traces",
    description: "回放最近请求的完整链路轨迹 (路由→重试→换渠道→降级 · 含每步耗时与错误)",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "条数上限 · 默认 20" } },
    },
    run: (args) => callProxy("GET", `/origin/ea/traces?limit=${Number(args.limit) || 20}`),
  },
  {
    name: "dao_failure_stats",
    description: "失败模式统计: 每个渠道按错误类型聚合 (auth/限流/5xx/超时…) 并给出建议",
    inputSchema: { type: "object", properties: {} },
    run: () => callProxy("GET", "/origin/ea/failure-stats"),
  },
  {
    name: "dao_audit_log",
    description: "查看配置动作审计日志 (谁何时改了什么配置 · apiKey 已脱敏)",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "条数上限 · 默认 50" } },
    },
    run: (args) => callProxy("GET", `/origin/ea/audit?limit=${Number(args.limit) || 50}`),
  },
  {
    name: "dao_config_backups",
    description: "列出配置历史备份 (新→旧) · 供回滚选择",
    inputSchema: { type: "object", properties: {} },
    run: () => callProxy("GET", "/origin/ea/config-backups"),
  },
  {
    name: "dao_config_rollback",
    description: "一键回滚配置到指定历史备份 (回滚前自动再备份当前配置 · 回滚后热重载)",
    inputSchema: {
      type: "object",
      properties: {
        backup: { type: "string", description: "备份文件名 (dao_config_backups 返回的 name)" },
      },
      required: ["backup"],
    },
    run: (args) => callProxy("POST", "/origin/ea/config-rollback", { backup: args.backup }),
  },
];

const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

function respond(id, result, error) {
  const msg = { jsonrpc: "2.0", id };
  if (error) msg.error = error;
  else msg.result = result;
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return respond(id, {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fomo-flow", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized" || String(method).startsWith("notifications/"))
    return; // 通知无需应答
  if (method === "tools/list") {
    return respond(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
  }
  if (method === "tools/call") {
    const tool = toolByName.get(params && params.name);
    if (!tool)
      return respond(id, null, { code: -32602, message: `unknown tool: ${params && params.name}` });
    try {
      const result = await tool.run((params && params.arguments) || {});
      return respond(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result && result.ok === false,
      });
    } catch (e) {
      return respond(id, {
        content: [{ type: "text", text: e.message }],
        isError: true,
      });
    }
  }
  if (id !== undefined)
    respond(id, null, { code: -32601, message: `method not found: ${method}` });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  handle(msg).catch(() => {});
});
rl.on("close", () => process.exit(0));

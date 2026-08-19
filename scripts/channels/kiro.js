#!/usr/bin/env node
"use strict";

/**
 * kiro-acp 通道 · 经官方 `kiro-cli acp` stdio JSON-RPC 接入
 * ──────────────────────────────────────────────────────────────────────
 * 只走本机 kiro-cli 进程 (Agent Client Protocol), 不读 Kiro 凭据、不打
 * 非官方 HTTP 端点、不自动放行工具权限。
 *
 * 权限边界 (相对曾被排除的 auto-allow 原型):
 *   - clientCapabilities.fs / terminal 一律声明为 false
 *   - session/request_permission → 固定 outcome=cancelled
 *   - fs/read_text_file、fs/write_text_file、terminal/* → method not found
 *   工具执行权留给调用方 OpenAI harness; 本通道只把 Kiro 当文本/JSON 桥。
 *
 * 实现 Channel Contract (见 channels/index.js)。
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const { parseToolDecision, toPrompt } = require(path.join(__dirname, "mirasim-cli.js"));

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const PROTOCOL_VERSION = 1;

function isPermissionMethod(method) {
  const name = String(method || "").toLowerCase().replace(/_/g, "/");
  return name === "session/requestpermission" || name === "session/request/permission";
}

function isForbiddenClientMethod(method) {
  const name = String(method || "").toLowerCase();
  return (
    name.startsWith("fs/") ||
    name.startsWith("terminal/") ||
    name === "fs.readtextfile" ||
    name === "fs.writetextfile"
  );
}

function updateKind(update) {
  if (!update || typeof update !== "object") return "";
  return String(update.sessionUpdate || update.type || "")
    .toLowerCase()
    .replace(/_/g, "");
}

function chunkText(update) {
  if (!update || typeof update !== "object") return "";
  const kind = updateKind(update);
  if (kind !== "agentmessagechunk" && kind !== "agentmessage") return "";
  const content = update.content;
  if (typeof content === "string") return content;
  if (content && typeof content.text === "string") return content.text;
  return "";
}

function createKiroAcpClient(options = {}) {
  const cliPath = String(options.cliPath || process.env.KIRO_CLI_PATH || "kiro-cli").trim() || "kiro-cli";
  const args = Array.isArray(options.args) && options.args.length ? options.args.slice() : ["acp"];
  const cwd = String(options.cwd || process.env.KIRO_CWD || process.cwd());
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const spawnImpl = typeof options.spawn === "function" ? options.spawn : spawn;
  const env = options.env && typeof options.env === "object" ? options.env : process.env;

  function startChild() {
    const child = spawnImpl(cliPath, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child || !child.stdin || !child.stdout) {
      throw new Error("failed to spawn kiro-cli ACP process");
    }
    if (child.stderr && typeof child.stderr.resume === "function") child.stderr.resume();
    return child;
  }

  function attach(child, hooks = {}) {
    let buf = "";
    let nextId = 1;
    const pending = new Map();
    const denied = { permission: 0, clientMethod: 0 };
    let closed = false;

    function send(obj) {
      if (closed) return;
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch (error) {
        failAll(error);
      }
    }

    function failAll(error) {
      if (closed) return;
      closed = true;
      for (const [, job] of pending) job.reject(error);
      pending.clear();
    }

    function handle(msg) {
      if (!msg || typeof msg !== "object") return;
      const method = String(msg.method || "");
      if (method && msg.id !== undefined && msg.id !== null && !("result" in msg) && !("error" in msg)) {
        if (isPermissionMethod(method)) {
          denied.permission += 1;
          send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
          return;
        }
        if (isForbiddenClientMethod(method)) {
          denied.clientMethod += 1;
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "kiro channel disables host fs/terminal capabilities" },
          });
          return;
        }
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${method}` } });
        return;
      }
      if ((method === "session/update" || method === "session/notification") && hooks.onUpdate) {
        hooks.onUpdate(msg.params || {}, denied);
      }
      if (msg.id === undefined || msg.id === null) return;
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      if (msg.error) job.reject(new Error(msg.error.message || `ACP error ${msg.error.code}`));
      else job.resolve(msg.result);
    }

    if (typeof child.stdout.setEncoding === "function") child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += String(chunk);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        handle(msg);
      }
    });
    child.on("error", (error) => failAll(error && error.message ? error : new Error("kiro-cli ACP process error")));
    child.on("exit", (code, signal) => {
      if (!closed) failAll(new Error(`kiro-cli ACP exited (${signal || code})`));
    });

    function rpc(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Kiro ACP timed out on ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        send({ jsonrpc: "2.0", id, method, params });
      });
    }

    function close() {
      failAll(new Error("Kiro ACP session closed"));
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
    }

    return { rpc, close, denied, send };
  }

  // 每个 rpc() 自带 timeoutMs 超时, 会话级不再叠加墙钟计时器 —— 否则
  // initialize/auth/session_new 的耗时会挤占 session/prompt 的可用时间。
  async function withSession(fn, hooks = {}) {
    const child = startChild();
    const session = attach(child, hooks);
    try {
      const init = await session.rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "dao-flow-kiro-channel", version: "1" },
      });
      const authMethods = Array.isArray(init && init.authMethods) ? init.authMethods : [];
      if (authMethods.length) {
        const methodId = authMethods[0] && (authMethods[0].id || authMethods[0].methodId);
        if (methodId) await session.rpc("authenticate", { methodId });
      }
      const created = await session.rpc("session/new", { cwd, mcpServers: [] });
      const sessionId = created && created.sessionId;
      if (!sessionId) throw new Error("Kiro ACP session/new did not return sessionId");
      session.sessionId = sessionId;
      return await fn({
        rpc: session.rpc,
        sessionId,
        denied: session.denied,
        agentInfo: init && init.agentInfo,
      });
    } finally {
      session.close();
    }
  }

  return {
    cliPath,
    async health() {
      try {
        let version = null;
        await withSession(async ({ agentInfo }) => {
          version = agentInfo && agentInfo.version || null;
        });
        return { ok: true, name: "kiro-acp", cliPath, version, permissionPolicy: "deny" };
      } catch (error) {
        return { ok: false, name: "kiro-acp", cliPath, permissionPolicy: "deny", error: String(error && error.message || error) };
      }
    },
    async complete(request, hooks = {}) {
      const tools = Array.isArray(request.tools) ? request.tools : [];
      const prompt = toPrompt({ messages: request.messages }, tools);
      let text = "";
      const denied = { permission: 0, clientMethod: 0 };
      await withSession(async ({ rpc, sessionId, denied: sessionDenied }) => {
        await rpc("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
        denied.permission = sessionDenied.permission;
        denied.clientMethod = sessionDenied.clientMethod;
      }, {
        onUpdate(params) {
          const update = params && (params.update || params);
          const delta = chunkText(update);
          if (!delta) return;
          text += delta;
          if (typeof hooks.onUpdate === "function") hooks.onUpdate({ text });
        },
      });
      let decision = { type: "final", content: text };
      if (tools.length && text) decision = parseToolDecision(text, tools);
      return {
        text: decision.type === "final" ? decision.content : text,
        toolCalls: decision.type === "tool_call" ? decision.tool_calls : [],
        usage: { inputTokens: 0, outputTokens: 0 },
        denied,
      };
    },
  };
}

function resolveAcp(options = {}) {
  if (options.acp) return options.acp;
  if (
    options.client &&
    typeof options.client.complete === "function" &&
    typeof options.client.health === "function"
  ) {
    return options.client;
  }
  return createKiroAcpClient(options);
}

function createKiroChannel(options = {}) {
  const acp = resolveAcp(options);
  const model = String(options.model || process.env.KIRO_GATEWAY_MODEL || "kiro").trim() || "kiro";

  async function health() {
    const status = await acp.health();
    return {
      ok: status.ok === true,
      name: "kiro-acp",
      upstream: status.name || "kiro",
      version: status.version || null,
      permissionPolicy: "deny",
      cliPath: status.cliPath || null,
      error: status.error || undefined,
    };
  }

  async function complete(request, hooks = {}) {
    const result = await acp.complete(request, hooks);
    const usage = result && result.usage && typeof result.usage === "object" ? result.usage : {};
    return {
      text: String((result && result.text) || ""),
      toolCalls: Array.isArray(result && result.toolCalls) ? result.toolCalls : [],
      usage: {
        inputTokens: Number(usage.inputTokens) || 0,
        outputTokens: Number(usage.outputTokens) || 0,
      },
    };
  }

  return { name: "kiro-acp", model, health, complete };
}

module.exports = {
  createKiroAcpClient,
  createKiroChannel,
  isForbiddenClientMethod,
  isPermissionMethod,
};

#!/usr/bin/env node
"use strict";
/**
 * dao-acp-agent.js · dao-flow 的标准 ACP agent 入口 (可执行)
 * ───────────────────────────────────────────────────────────────
 * 让任意 ACP 宿主(Zed/JetBrains/Gemini CLI/Codex 等)以 stdio 拉起 dao-flow:
 *
 *   宿主配置示例(Zed agent_servers): { "command": "node",
 *     "args": ["<repo>/scripts/dao-acp-agent.js"],
 *     "env": { "DAO_ACP_BASE_URL": "http://127.0.0.1:<port>/v1",
 *              "DAO_ACP_API_KEY": "<revproxy key>", "DAO_ACP_MODEL": "<model>" } }
 *
 * 推理经 OpenAI 兼容端点流式产出(默认指向 dao-flow 本地反代 /v1); 未配置端点时
 * 仍完成 ACP 握手并回一句提示(便于宿主侧连通性排查)。
 */

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { stateFile } = require(path.join(__dirname, "..", "core", "product_identity.js"));
const { createAcpAgent } = require(
  path.join(__dirname, "..", "vendor", "外接api", "core", "acp_agent.js"),
);
const { resolveUpstream, revproxyKeyPath } = require(
  path.join(__dirname, "..", "vendor", "外接api", "core", "acp_upstream.js"),
);
const { selectDaoEndpoint } = require(
  path.join(__dirname, "..", "core", "dao_local_endpoint.js"),
);

const DESKTOP_ENDPOINT_FILE =
  process.env.DAO_DESKTOP_ENDPOINT_FILE ||
  path.join(
    os.homedir() || "",
    "Library",
    "Application Support",
    "fomo-flow-desktop",
    "runtime",
    "endpoint.json",
  );

// 首次推理时懒解析上游 (默认自动发现本地反代 → 完整路由/缓存/脱敏栈), 记忆化。
let _upstreamPromise = null;
function upstream() {
  if (_upstreamPromise) return _upstreamPromise;
  _upstreamPromise = resolveUpstream({
    env: process.env,
    selectEndpoint: () =>
      selectDaoEndpoint({
        explicitUrl: process.env.DAO_ACP_API_URL || "",
        desktopDescriptorPath: DESKTOP_ENDPOINT_FILE,
        inheritedUrl: process.env.WINDSURF_API_SERVER_URL || "",
        fallbackUrl: "http://127.0.0.1:8937",
      }),
    readKeyFile: () => {
      const p = revproxyKeyPath();
      if (!p || !fs.existsSync(p)) return "";
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      return cfg && cfg.apiKey ? cfg.apiKey : "";
    },
  }).catch(() => ({ baseUrl: "", apiKey: "", model: "fomo-flow" }));
  return _upstreamPromise;
}

async function streamComplete({ messages, onChunk, isCancelled }) {
  const { baseUrl, apiKey, model } = await upstream();
  return new Promise((resolve) => {
    if (!baseUrl) {
      onChunk(
        "FOMO FLOW ACP agent 已连通, 但未找到本地反代端点。请在 FOMO FLOW 中开启" +
          "「模型反代」, 或显式设置 DAO_ACP_BASE_URL / DAO_ACP_API_KEY / DAO_ACP_MODEL。",
      );
      resolve({ stopReason: "end_turn" });
      return;
    }
    let url;
    try {
      url = new URL(
        baseUrl.endsWith("/chat/completions")
          ? baseUrl
          : baseUrl + "/chat/completions",
      );
    } catch (e) {
      onChunk(`[fomo-flow] 端点 URL 非法: ${baseUrl}`);
      resolve({ stopReason: "end_turn" });
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const payload = JSON.stringify({ model, messages, stream: true });
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (apiKey) {
      headers.Authorization = "Bearer " + apiKey;
      headers["x-api-key"] = apiKey;
    }
    const req = mod.request(url, { method: "POST", headers }, (resp) => {
      let sseBuf = "";
      let stopReason = "end_turn";
      resp.on("data", (d) => {
        if (isCancelled()) {
          try { req.destroy(); } catch (_) {}
          return;
        }
        sseBuf += d.toString("utf8");
        let nl;
        while ((nl = sseBuf.indexOf("\n")) >= 0) {
          const line = sseBuf.slice(0, nl).replace(/\r$/, "");
          sseBuf = sseBuf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const obj = JSON.parse(data);
            const choice = obj.choices && obj.choices[0];
            const delta = choice && (choice.delta || choice.message);
            if (delta && typeof delta.content === "string" && delta.content) {
              onChunk(delta.content);
            }
            if (choice && choice.finish_reason === "length") stopReason = "max_tokens";
          } catch (_) {}
        }
      });
      resp.on("end", () => resolve({ stopReason }));
      resp.on("error", () => resolve({ stopReason: "end_turn" }));
    });
    req.on("error", (e) => {
      onChunk(`[fomo-flow] 上游请求失败: ${e && e.message ? e.message : e}`);
      resolve({ stopReason: "end_turn" });
    });
    req.end(payload);
  });
}

// 文件持久化 store: 跨进程 session/load 恢复历史 (每会话一文件 · 有界会话数)。
const SESSIONS_DIR =
  process.env.DAO_ACP_SESSIONS_DIR ||
  stateFile("acp-sessions") ||
  path.join(os.homedir() || "", ".fomo-flow", "acp-sessions");
const MAX_SESSION_FILES = 200;
function _safeSessionId(sid) {
  return /^[A-Za-z0-9._-]{1,128}$/.test(String(sid || "")) ? String(sid) : "";
}
const fileStore = {
  save(sessionId, messages) {
    const sid = _safeSessionId(sessionId);
    if (!sid) return;
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const p = path.join(SESSIONS_DIR, sid + ".json");
      const tmp = p + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ messages, updatedAt: Date.now() }), { mode: 0o600 });
      fs.renameSync(tmp, p);
      _pruneSessions();
    } catch (_) {}
  },
  load(sessionId) {
    const sid = _safeSessionId(sessionId);
    if (!sid) return null;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, sid + ".json"), "utf8"));
      return Array.isArray(data && data.messages) ? data.messages : null;
    } catch (_) {
      return null;
    }
  },
};
function _pruneSessions() {
  try {
    const files = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(MAX_SESSION_FILES)) {
      try { fs.unlinkSync(path.join(SESSIONS_DIR, f)); } catch (_) {}
    }
  } catch (_) {}
}

const agent = createAcpAgent({
  input: process.stdin,
  output: process.stdout,
  complete: streamComplete,
  store: fileStore,
  agentName: "fomo-flow",
  agentVersion: process.env.DAO_ACP_AGENT_VERSION || "",
  log: (m) => process.stderr.write(m + "\n"),
  onEnd: () => process.exit(0),
});
agent.start();
process.stdin.resume();

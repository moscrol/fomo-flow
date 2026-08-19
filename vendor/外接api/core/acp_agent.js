"use strict";
/**
 * acp_agent.js · dao-flow 作为标准 ACP agent (Agent Client Protocol v1)
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 二十八章「为天下式」· 立通用之式 · 任何宿主皆可接
 *
 *   定位(P/ACP 里程碑 步骤4 · 最小可用): 让 dao-flow 以标准 ACP agent 身份被
 *   任意 ACP 宿主(Zed / JetBrains / Gemini CLI / Codex 等)通过 stdio 拉起并跑通
 *   一轮对话 —— 从「某 IDE 的插件」升级为「任意 IDE × 任意 agent 之间的桌子」。
 *
 *   传输(ndJSON 行分帧 + JSON-RPC 2.0 分发)与推理(complete 依赖注入)分离,
 *   可用内存流 + 假 complete 确定性测试, 不依赖真实上游/进程。
 *
 *   最小实现的方法: initialize / authenticate / session/new / session/prompt /
 *   session/cancel。prompt 经注入的 complete 流式产出, 以 session/update 的
 *   agent_message_chunk 回推, 结束以 stopReason 应答 session/prompt。
 */

const PROTOCOL_VERSION = 1;
const STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);

function createAcpAgent(opts = {}) {
  const input = opts.input;
  const output = opts.output;
  const complete = typeof opts.complete === "function" ? opts.complete : null;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const genId = typeof opts.genId === "function" ? opts.genId : _defaultGenId;
  const agentName = opts.agentName || "fomo-flow";
  const agentVersion = opts.agentVersion || "";
  // 可选持久化存储 (跨进程 session/load): { load(sessionId)->messages|null, save(sessionId, messages) }
  const store = opts.store && typeof opts.store === "object" ? opts.store : null;
  const maxHistoryMessages = Number(opts.maxHistoryMessages) > 0
    ? Math.floor(Number(opts.maxHistoryMessages))
    : 200;

  const sessions = new Map();
  const _sessionLocks = new Map(); // sessionId → Promise 链, 同会话 prompt 串行
  let buf = "";

  function _withSessionLock(sessionId, fn) {
    const key = sessionId || "";
    const prev = _sessionLocks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    _sessionLocks.set(
      key,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  function _persist(sessionId, session) {
    if (!store || typeof store.save !== "function") return;
    try {
      store.save(sessionId, session.messages);
    } catch (_) {}
  }

  function _trimHistory(session) {
    // 有界历史: 恒保首条(常为长期指令), 超限则裁最旧的中段
    if (session.messages.length <= maxHistoryMessages) return;
    const overflow = session.messages.length - maxHistoryMessages;
    session.messages.splice(1, overflow);
  }

  function _send(obj) {
    try {
      output.write(JSON.stringify(obj) + "\n");
    } catch (_) {}
  }
  const _result = (id, result) => _send({ jsonrpc: "2.0", id, result });
  const _error = (id, code, message) =>
    _send({ jsonrpc: "2.0", id, error: { code, message } });
  const _notify = (method, params) => _send({ jsonrpc: "2.0", method, params });

  async function _handle(msg) {
    if (!msg || typeof msg !== "object") return;
    const { id, method } = msg;
    const params = msg.params || {};
    if (method === undefined) return; // 对客户端响应的回执: 最小实现不主动调客户端, 忽略
    try {
      switch (method) {
        case "initialize":
          _result(id, {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: {
                image: false,
                audio: false,
                embeddedContext: false,
              },
            },
            agentInfo: { name: agentName, version: agentVersion },
            authMethods: [],
          });
          return;
        case "authenticate":
        case "auth/login":
          _result(id, {});
          return;
        case "session/new": {
          const sessionId = genId("sess");
          sessions.set(sessionId, {
            cwd: params.cwd || "",
            cancelled: false,
            messages: [],
          });
          _result(id, { sessionId });
          return;
        }
        case "session/load":
          await _withSessionLock(params.sessionId, () => _handleLoad(id, params));
          return;
        case "session/cancel": {
          const s = sessions.get(params.sessionId);
          if (s) s.cancelled = true;
          return; // 通知, 无响应
        }
        case "session/prompt":
          await _withSessionLock(params.sessionId, () => _handlePrompt(id, params));
          return;
        default:
          if (id !== undefined && id !== null)
            _error(id, -32601, `method not found: ${method}`);
          return;
      }
    } catch (e) {
      if (id !== undefined && id !== null)
        _error(id, -32603, e && e.message ? e.message : String(e));
    }
  }

  async function _handlePrompt(id, params) {
    const sessionId = params.sessionId;
    const session = sessions.get(sessionId);
    if (!session) {
      _error(id, -32602, "unknown sessionId");
      return;
    }
    session.cancelled = false;
    const text = _promptText(params.prompt);
    // 多轮上下文: 追加本轮 user 消息, 把完整历史交给推理 (此前每轮只发单条 → 模型看不到上文)
    session.messages.push({ role: "user", content: text });
    _trimHistory(session);
    const messages = session.messages.slice();
    if (!complete) {
      _result(id, { stopReason: "end_turn" });
      return;
    }
    let stopReason = "end_turn";
    let assembled = "";
    try {
      const res = await complete({
        sessionId,
        messages,
        isCancelled: () => session.cancelled,
        onChunk: (chunk) => {
          if (!chunk) return;
          assembled += String(chunk);
          _notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: String(chunk) },
            },
          });
        },
      });
      if (session.cancelled) stopReason = "cancelled";
      else if (res && STOP_REASONS.has(res.stopReason)) stopReason = res.stopReason;
    } catch (e) {
      log("[acp] complete error: " + (e && e.message ? e.message : String(e)));
      stopReason = session.cancelled ? "cancelled" : "refusal";
      _notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `\n[dao-flow error] ${e && e.message ? e.message : e}`,
          },
        },
      });
      assembled = ""; // 失败文本不入历史, 避免污染后续轮次
    }
    // 把本轮 assistant 回复并入历史 (供下一轮 · 取消也保留已产出部分)
    if (assembled) session.messages.push({ role: "assistant", content: assembled });
    _persist(sessionId, session);
    _result(id, { stopReason });
  }

  // session/load: 恢复既有会话上下文, 以 session/update 回放历史, 再应答。
  //   进程内存已有则直接用; 否则从持久化存储恢复。
  async function _handleLoad(id, params) {
    const sessionId = params.sessionId;
    if (!sessionId) {
      _error(id, -32602, "sessionId required");
      return;
    }
    let session = sessions.get(sessionId);
    if (!session) {
      let restored = null;
      if (store && typeof store.load === "function") {
        try {
          restored = store.load(sessionId);
        } catch (_) {
          restored = null;
        }
      }
      if (!Array.isArray(restored)) {
        _error(id, -32602, "unknown sessionId");
        return;
      }
      session = { cwd: params.cwd || "", cancelled: false, messages: restored };
      sessions.set(sessionId, session);
    }
    // 回放历史: user/assistant 各以对应 chunk 更新推回 (v1: user_message_chunk / agent_message_chunk)
    for (const msg of session.messages) {
      if (!msg || typeof msg.content !== "string" || !msg.content) continue;
      const sessionUpdate =
        msg.role === "assistant" ? "agent_message_chunk" : "user_message_chunk";
      _notify("session/update", {
        sessionId,
        update: { sessionUpdate, content: { type: "text", text: msg.content } },
      });
    }
    _result(id, {});
  }

  function _onData(chunk) {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue; // 非法行跳过, 不拖垮传输
      }
      Promise.resolve(_handle(msg)).catch((e) => {
        log("[acp] handle error: " + (e && e.message ? e.message : String(e)));
      });
    }
  }

  function start() {
    input.on("data", _onData);
    if (typeof opts.onEnd === "function") input.on("end", opts.onEnd);
    return {
      stop() {
        try {
          input.off("data", _onData);
        } catch (_) {}
      },
    };
  }

  return { start, handle: _handle, promptText: _promptText, sessions };
}

// ACP prompt 是 content block 数组; 抽出文本用于推理 (最小实现只取 text/resource 文本)
function _promptText(prompt) {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  const parts = [];
  for (const block of prompt) {
    if (!block) continue;
    if (typeof block === "string") {
      parts.push(block);
    } else if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (
      block.type === "resource" &&
      block.resource &&
      typeof block.resource.text === "string"
    ) {
      parts.push(block.resource.text);
    }
  }
  return parts.join("\n");
}

function _defaultGenId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

module.exports = { createAcpAgent, PROTOCOL_VERSION, STOP_REASONS };

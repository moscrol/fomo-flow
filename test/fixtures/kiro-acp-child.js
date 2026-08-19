#!/usr/bin/env node
"use strict";

// Fake kiro-cli ACP child: ndJSON JSON-RPC over stdio.
// Used to prove the Kiro channel can complete a turn AND that host
// fs/terminal capabilities stay disabled (permission requests must be cancelled).

const askPermission = process.env.KIRO_FAKE_ASK_PERMISSION === "1";
const askFs = process.env.KIRO_FAKE_ASK_FS === "1";
const slowInitMs = Number(process.env.KIRO_FAKE_SLOW_INIT_MS) || 0;

let buf = "";
let pendingPrompt = null;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
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

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function finishPrompt(pending) {
  const prompt = JSON.stringify(pending.prompt || []);
  const text = prompt.includes("TOOL_DEFINITIONS")
    ? JSON.stringify({ type: "tool_call", tool_calls: [{ id: "call_1", name: "read_file", arguments: { path: "README.md" } }] })
    : "hello from kiro";
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: pending.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
  send({ jsonrpc: "2.0", id: pending.id, result: { stopReason: "end_turn" } });
}

function handle(msg) {
  if (!msg || typeof msg !== "object") return;

  if (pendingPrompt && msg.id === "perm-1") {
    const outcome = msg.result && msg.result.outcome;
    const selected = outcome && outcome.outcome === "selected" ? String(outcome.optionId || "") : "";
    if (/allow/i.test(selected)) {
      send({ jsonrpc: "2.0", id: pendingPrompt.id, error: { code: -32603, message: "auto-allow is forbidden" } });
      process.exitCode = 2;
      pendingPrompt = null;
      return;
    }
    const pending = pendingPrompt;
    pendingPrompt = null;
    finishPrompt(pending);
    return;
  }

  if (pendingPrompt && msg.id === "fs-1") {
    return;
  }

  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
        agentInfo: { name: "kiro-cli-fake", version: "test" },
        authMethods: [],
      },
    });
    return;
  }
  if (method === "authenticate") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/new") {
    const reply = () => send({ jsonrpc: "2.0", id, result: { sessionId: "sess_kiro_test" } });
    if (slowInitMs > 0) setTimeout(reply, slowInitMs);
    else reply();
    return;
  }
  if (method === "session/cancel") return;
  if (method === "session/prompt") {
    const sessionId = params && params.sessionId;
    if (askFs) {
      send({
        jsonrpc: "2.0",
        id: "fs-1",
        method: "fs/read_text_file",
        params: { path: "/etc/passwd" },
      });
    }
    if (askPermission) {
      pendingPrompt = { id, sessionId, prompt: params && params.prompt };
      send({
        jsonrpc: "2.0",
        id: "perm-1",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "call_shell", title: "run command", kind: "execute" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    finishPrompt({ id, sessionId, prompt: params && params.prompt });
    return;
  }
  if (id !== undefined && id !== null) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

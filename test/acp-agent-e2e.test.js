"use strict";

// 端到端: 真正 spawn dao-acp-agent.js 进程, 走 stdio ndJSON, 推理指向假 OpenAI
// SSE 服务器 —— 证明 ACP 握手 + session/prompt 流式解析的完整链路。

const assert = require("node:assert");
const http = require("node:http");
const cp = require("node:child_process");
const path = require("node:path");

const BIN = path.join(__dirname, "..", "scripts", "dao-acp-agent.js");

function sse(res, deltas) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const d of deltas) {
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: d } }] }) + "\n\n");
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url.includes("/chat/completions")) {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => sse(res, ["Hello", ", world"]));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const child = cp.spawn(process.execPath, [BIN], {
    env: {
      ...process.env,
      DAO_ACP_BASE_URL: `http://127.0.0.1:${port}/v1`,
      DAO_ACP_MODEL: "test-model",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const responses = [];
  const waiters = [];
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk.toString("utf8");
    let nl;
    while ((nl = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      responses.push(msg);
      waiters.forEach((w) => w());
    }
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const waitFor = (pred, ms = 4000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const m = responses.find(pred);
        if (m) { cleanup(); resolve(m); }
      };
      const t = setTimeout(() => { cleanup(); reject(new Error("timeout waiting for message")); }, ms);
      const cleanup = () => { clearTimeout(t); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); };
      waiters.push(check);
      check();
    });

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const init = await waitFor((m) => m.id === 1);
    assert.strictEqual(init.result.protocolVersion, 1, "initialize handshake");

    send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
    const ns = await waitFor((m) => m.id === 2);
    const sessionId = ns.result.sessionId;
    assert.ok(sessionId, "got sessionId");

    send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hi" }] } });
    const done = await waitFor((m) => m.id === 3);
    assert.strictEqual(done.result.stopReason, "end_turn", "prompt completed with end_turn");

    const chunks = responses
      .filter((m) => m.method === "session/update" && m.params.update.sessionUpdate === "agent_message_chunk")
      .map((m) => m.params.update.content.text)
      .join("");
    assert.strictEqual(chunks, "Hello, world", "streamed upstream SSE deltas as ACP chunks");

    console.log("acp agent e2e selftest: PASS");
  } finally {
    try { child.kill(); } catch (_) {}
    server.close();
  }
  process.exit(0);
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});

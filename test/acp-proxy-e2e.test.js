"use strict";

// 端到端: 编辑器 → dao-acp-proxy(中间人·开脱敏) → 真实下游 ACP agent(复用
// dao-acp-agent) → 假 OpenAI SSE。证明: 中间人透明包裹真 agent, 握手/流式全通,
// 且出站 prompt 里的密钥在到达下游(及模型)之前已被脱敏。

const assert = require("node:assert");
const http = require("node:http");
const cp = require("node:child_process");
const path = require("node:path");

const PROXY = path.join(__dirname, "..", "scripts", "dao-acp-proxy.js");
const AGENT = path.join(__dirname, "..", "scripts", "dao-acp-agent.js");
const SECRET = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234567890";

(async () => {
  let received = "";
  const server = http.createServer((req, res) => {
    if (req.url.includes("/chat/completions")) {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        received = b;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "OK" } }] }) + "\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  // 中间人包裹真实 agent; agent 的推理指向假 OpenAI; 代理开启出站脱敏
  const child = cp.spawn(
    process.execPath,
    [PROXY, "--", process.execPath, AGENT],
    {
      env: {
        ...process.env,
        DAO_ACP_BASE_URL: `http://127.0.0.1:${port}/v1`,
        DAO_ACP_MODEL: "test-model",
        DAO_ACP_PROXY_REDACT: "1",
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );

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
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const waitFor = (pred, ms = 5000) =>
    new Promise((resolve, reject) => {
      const check = () => { const m = responses.find(pred); if (m) { cleanup(); resolve(m); } };
      const t = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, ms);
      const cleanup = () => { clearTimeout(t); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); };
      waiters.push(check); check();
    });

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const init = await waitFor((m) => m.id === 1);
    assert.strictEqual(init.result.protocolVersion, 1, "handshake through proxy → downstream agent");

    send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
    const ns = await waitFor((m) => m.id === 2);
    const sessionId = ns.result.sessionId;
    assert.ok(sessionId, "sessionId via proxy");

    send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: `use ${SECRET} now` }] } });
    const done = await waitFor((m) => m.id === 3);
    assert.strictEqual(done.result.stopReason, "end_turn", "prompt completed through the chain");

    const chunks = responses
      .filter((m) => m.method === "session/update" && m.params.update.sessionUpdate === "agent_message_chunk")
      .map((m) => m.params.update.content.text)
      .join("");
    assert.strictEqual(chunks, "OK", "agent output streamed back through proxy to editor");

    // 关键: 到达模型(经下游 agent)的请求体不含明文密钥 —— 中间人已脱敏
    assert.ok(received.length > 0, "upstream received the request");
    assert.ok(!received.includes(SECRET), "secret redacted by middleman before reaching model");

    console.log("acp proxy e2e selftest: PASS");
  } finally {
    try { child.kill(); } catch (_) {}
    server.close();
  }
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

"use strict";

const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const { createChannel } = require("../scripts/channels/index.js");
const { createKiroAcpClient, createKiroChannel, isPermissionMethod } = require("../scripts/channels/kiro.js");
const { createGateway } = require("../scripts/mirasim-openai-gateway.js");

const FIXTURE = path.join(__dirname, "fixtures", "kiro-acp-child.js");

function kiroOptions(extra = {}) {
  const { env, ...rest } = extra;
  return {
    cliPath: process.execPath,
    args: [FIXTURE],
    cwd: path.join(__dirname, ".."),
    timeoutMs: 4000,
    ...rest,
    env: { ...process.env, ...(env || {}) },
  };
}

async function main() {
  assert.strictEqual(isPermissionMethod("session/request_permission"), true);
  assert.strictEqual(isPermissionMethod("session/requestPermission"), true);

  const channel = createChannel(kiroOptions({ transport: "kiro", model: "kiro" }));
  assert.strictEqual(channel.name, "kiro-acp");

  const health = await channel.health();
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.permissionPolicy, "deny");

  const textResult = await channel.complete({ messages: [{ role: "user", content: "hello" }] });
  assert.strictEqual(textResult.text, "hello from kiro");
  assert.deepStrictEqual(textResult.toolCalls, []);

  const toolResult = await channel.complete({
    messages: [{ role: "user", content: "Read README.md" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  });
  assert.strictEqual(toolResult.toolCalls.length, 1);
  assert.strictEqual(toolResult.toolCalls[0].function.name, "read_file");

  const acp = createKiroAcpClient(kiroOptions({ env: { KIRO_FAKE_ASK_PERMISSION: "1", KIRO_FAKE_ASK_FS: "1" } }));
  const deniedTurn = await acp.complete({ messages: [{ role: "user", content: "run a command" }] });
  assert.strictEqual(deniedTurn.text, "hello from kiro");
  assert.ok(deniedTurn.denied.permission >= 1, "permission requests must be counted as denied");
  assert.ok(deniedTurn.denied.clientMethod >= 1, "fs/read_text_file must be rejected");

  // 回归: timeoutMs 只按单个 rpc 计, 初始化耗时不得挤占 session/prompt
  // (旧实现的会话级墙钟会在 init 700ms 后只给 prompt 留 300ms 就 SIGTERM)
  const slowInit = createKiroAcpClient(kiroOptions({
    timeoutMs: 1000,
    env: { KIRO_FAKE_SLOW_INIT_MS: "700" },
  }));
  const slowResult = await slowInit.complete({ messages: [{ role: "user", content: "hello" }] });
  assert.strictEqual(slowResult.text, "hello from kiro", "prompt must survive slow initialization");

  const injected = createKiroChannel({
    model: "kiro",
    client: {
      health: async () => ({ ok: true, name: "injected-kiro" }),
      complete: async () => ({ text: "injected", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }),
    },
  });
  const injectedResult = await injected.complete({ messages: [{ role: "user", content: "hi" }] });
  assert.strictEqual(injectedResult.text, "injected");

  const gateway = createGateway({
    apiKey: "gateway-key",
    model: "kiro",
    transport: "kiro",
    kiroOptions: kiroOptions(),
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const port = gateway.address().port;
  try {
    const health = await new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: "/health" }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }).on("error", reject);
    });
    assert.strictEqual(health.status, 200);
    const healthBody = JSON.parse(health.body);
    assert.strictEqual(healthBody.channel, "kiro-acp");
    assert.strictEqual(healthBody.transport, "kiro");

    const completion = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ model: "kiro", messages: [{ role: "user", content: "hello" }] });
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: "Bearer gateway-key",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    assert.strictEqual(completion.status, 200);
    assert.strictEqual(JSON.parse(completion.body).choices[0].message.content, "hello from kiro");
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
  }

  console.log("kiro channel selftest: PASS");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

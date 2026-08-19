"use strict";

const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const { createGateway, loadConfig, toPrompt } = require("../scripts/mirasim-openai-gateway.js");
const { createDirectRelay, toAnthropicMessages, toAnthropicToolChoice } = require("../scripts/mirasim-direct-relay.js");

function request(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        ...headers,
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  assert.strictEqual(
    toPrompt({ messages: [{ role: "system", content: "be concise" }, { role: "user", content: "hello" }] }),
    "SYSTEM: be concise\n\nUSER: hello",
  );
  assert.deepStrictEqual(toAnthropicMessages([
    { role: "system", content: "be concise" },
    { role: "user", content: "Read README.md" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) } }] },
    { role: "tool", tool_call_id: "call_1", content: "README contents" },
  ]), [
    { role: "user", content: [{ type: "text", text: "Read README.md" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "README contents" }] },
  ]);
  assert.deepStrictEqual(toAnthropicMessages([
    { role: "user", content: "use two tools" },
    { role: "assistant", content: null, tool_calls: [
      { id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a" }) } },
      { id: "call_2", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "b" }) } },
    ] },
    { role: "tool", tool_call_id: "call_1", content: "A" },
    { role: "tool", tool_call_id: "call_2", content: "B" },
  ]), [
    { role: "user", content: [{ type: "text", text: "use two tools" }] },
    { role: "assistant", content: [
      { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } },
      { type: "tool_use", id: "call_2", name: "read_file", input: { path: "b" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_1", content: "A" },
      { type: "tool_result", tool_use_id: "call_2", content: "B" },
    ] },
  ]);

  let directCalls = 0;
  let directRequest;
  const relay = createDirectRelay({
    token: "relay-token",
    baseURL: "https://relay.test",
    model: "claude-opus-5",
    fetchImpl: async (url, init) => {
      directCalls += 1;
      directRequest = { url, init, body: JSON.parse(init.body) };
      const response = directRequest.body.tools
        ? { content: [{ type: "tool_use", id: "call_read_1", name: "read_file", input: { path: "README.md" } }], stop_reason: "tool_use", usage: { input_tokens: 4, output_tokens: 5 } }
        : { content: [{ type: "text", text: "direct hello" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 3 } };
      return { ok: true, status: 200, json: async () => response, text: async () => "" };
    },
  });
  const directHealth = await relay.health();
  assert.strictEqual(directHealth.name, "mirasim-direct-relay");
  const directResult = await relay.complete({ model: "mirasim-agent", messages: [{ role: "user", content: "hello" }] });
  assert.strictEqual(directResult.text, "direct hello");
  assert.strictEqual(directRequest.url, "https://relay.test/v1/messages");
  assert.strictEqual(directRequest.init.headers.authorization, "Bearer relay-token");
  assert.strictEqual(directRequest.body.model, "claude-opus-5");
  assert.strictEqual(directCalls, 1);
  assert.deepStrictEqual(toAnthropicToolChoice("required"), { type: "any" });
  assert.deepStrictEqual(toAnthropicToolChoice({ type: "function", function: { name: "read_file" } }), { type: "tool", name: "read_file" });

  const streamedUpdates = [];
  const streamedRelay = createDirectRelay({
    token: "relay-token",
    baseURL: "https://relay.test",
    fetchImpl: async () => new Response([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const streamedResult = await streamedRelay.complete({
    stream: true,
    messages: [{ role: "user", content: "hello" }],
    onUpdate: (update) => streamedUpdates.push(update),
  });
  assert.strictEqual(streamedResult.text, "hello");
  assert.deepStrictEqual(streamedResult.usage, { inputTokens: 4, outputTokens: 5 });
  assert.ok(streamedUpdates.some((update) => update.text === "hello"));

  let runTaskCalls = 0;
  const directClient = {
    health: async () => ({ ok: true, name: "should-not-be-used" }),
    runTask: async () => {
      runTaskCalls += 1;
      throw new Error("CLI transport was unexpectedly invoked");
    },
  };
  const directServer = createGateway({ apiKey: "gateway-key", client: directClient, relay, model: "mirasim-agent" });
  await new Promise((resolve) => directServer.listen(0, "127.0.0.1", resolve));
  const directPort = directServer.address().port;
  try {
    const directResponse = await request(directPort, "POST", "/v1/chat/completions", {
      model: "mirasim-agent",
      messages: [{ role: "user", content: "hello" }],
    }, { authorization: "Bearer gateway-key" });
    assert.strictEqual(directResponse.status, 200);
    assert.strictEqual(JSON.parse(directResponse.body).choices[0].message.content, "direct hello");
    assert.strictEqual(runTaskCalls, 0);
  } finally {
    await new Promise((resolve) => directServer.close(resolve));
  }

  const client = {
    health: async () => ({ ok: true, name: "mirasim", channelConfigured: true }),
    runTask: async (task, options) => {
      const text = task.prompt.includes("TOOL_CALL_ID:")
        ? JSON.stringify({ type: "final", content: "read completed" })
        : task.prompt.includes("TOOL_DEFINITIONS:")
          ? JSON.stringify({ type: "tool_call", tool_calls: [{ id: "call_read_1", name: "read_file", arguments: { path: "README.md" } }] })
          : "hello";
      options.onUpdate({ phase: "running", text: text.slice(0, Math.max(1, Math.floor(text.length / 2))) });
      options.onUpdate({ phase: "completed", text, usage: { outputTokens: 2, inputTokens: 3 } });
      return { phase: "completed", text, usage: { outputTokens: 2, inputTokens: 3 } };
    },
  };
  const server = createGateway({ apiKey: "gateway-key", client, model: "mirasim-agent", transport: "cli" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const unauthenticated = await request(port, "GET", "/v1/models");
    assert.strictEqual(unauthenticated.status, 401);

    const models = await request(port, "GET", "/v1/models", null, { authorization: "Bearer gateway-key" });
    assert.strictEqual(models.status, 200);
    assert.strictEqual(JSON.parse(models.body).data[0].id, "mirasim-agent");

    const unary = await request(port, "POST", "/v1/chat/completions", {
      model: "mirasim-agent",
      messages: [{ role: "user", content: "hello" }],
    }, { "x-api-key": "gateway-key" });
    assert.strictEqual(unary.status, 200);
    const completion = JSON.parse(unary.body);
    assert.strictEqual(completion.choices[0].message.content, "hello");
    assert.deepStrictEqual(completion.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });

    const tools = [{
      type: "function",
      function: {
        name: "read_file",
        description: "Read a workspace file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }];
    const toolRound = await request(port, "POST", "/v1/chat/completions", {
      model: "mirasim-agent",
      tools,
      messages: [{ role: "user", content: "Read README.md" }],
    }, { authorization: "Bearer gateway-key" });
    assert.strictEqual(toolRound.status, 200);
    const toolCompletion = JSON.parse(toolRound.body);
    assert.strictEqual(toolCompletion.choices[0].finish_reason, "tool_calls");
    assert.deepStrictEqual(toolCompletion.choices[0].message.tool_calls, [{
      id: "call_read_1",
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
    }]);

    const finalRound = await request(port, "POST", "/v1/chat/completions", {
      model: "mirasim-agent",
      tools,
      messages: [
        { role: "user", content: "Read README.md" },
        { role: "assistant", content: null, tool_calls: toolCompletion.choices[0].message.tool_calls },
        { role: "tool", tool_call_id: "call_read_1", content: "README contents" },
      ],
    }, { authorization: "Bearer gateway-key" });
    assert.strictEqual(finalRound.status, 200);
    assert.strictEqual(JSON.parse(finalRound.body).choices[0].message.content, "read completed");

    const streamedToolRound = await request(port, "POST", "/v1/chat/completions", {
      model: "mirasim-agent",
      stream: true,
      tools,
      messages: [{ role: "user", content: "Read README.md" }],
    }, { authorization: "Bearer gateway-key" });
    assert.strictEqual(streamedToolRound.status, 200);
    assert.match(streamedToolRound.headers["content-type"], /text\/event-stream/);
    assert.match(streamedToolRound.body, /"tool_calls"/);
    assert.match(streamedToolRound.body, /"name":"read_file"/);
    assert.match(streamedToolRound.body, /data: \[DONE\]/);

    const undeclared = await request(port, "POST", "/v1/chat/completions", {
      model: "mirasim-agent",
      tools: [{ type: "function", function: { name: "write_file", parameters: { type: "object" } } }],
      messages: [{ role: "user", content: "Write a file" }],
    }, { authorization: "Bearer gateway-key" });
    assert.strictEqual(undeclared.status, 502);
    assert.match(JSON.parse(undeclared.body).error.message, /undeclared tool/);

    const streamed = await request(port, "POST", "/v1/chat/completions", {
      model: "mirasim-agent",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }, { authorization: "Bearer gateway-key" });
    assert.strictEqual(streamed.status, 200);
    assert.match(streamed.headers["content-type"], /text\/event-stream/);
    assert.match(streamed.body, /"content":"he"/);
    assert.match(streamed.body, /"content":"llo"/);
    assert.match(streamed.body, /data: \[DONE\]/);

    const unsupported = await request(port, "POST", "/v1/chat/completions", {
      model: "other",
      messages: [{ role: "user", content: "hello" }],
    }, { authorization: "Bearer gateway-key" });
    assert.strictEqual(unsupported.status, 400);

    const previousConfig = process.env.MIRASIM_GATEWAY_CONFIG;
    process.env.MIRASIM_GATEWAY_CONFIG = path.join(__dirname, "missing-mirasim-gateway.json");
    assert.deepStrictEqual(loadConfig(), {});
    if (previousConfig === undefined) delete process.env.MIRASIM_GATEWAY_CONFIG;
    else process.env.MIRASIM_GATEWAY_CONFIG = previousConfig;

    console.log("mirasim OpenAI gateway selftest: PASS");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

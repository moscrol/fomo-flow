"use strict";

/**
 * 通道层测试 · 本地通道适配器 (channels/)
 * ──────────────────────────────────────────────────────────────────────
 * 覆盖:
 *   1. channels/index.js 工厂: transport=cli / direct-relay / kiro / 未知
 *   2. channels/mirasim-cli.js: toPrompt / parseToolDecision (工具桥协议)
 *   3. channels/mirasim-relay.js: 归一化 {text, toolCalls, usage} 契约
 *
 * 全部用 fake 上游, 不发真实请求。
 */

const assert = require("node:assert");
const { createChannel } = require("../scripts/channels/index.js");
const { createMirasimCliChannel, toPrompt, parseToolDecision } = require("../scripts/channels/mirasim-cli.js");
const { createMirasimRelayChannel } = require("../scripts/channels/mirasim-relay.js");

async function main() {
  // ── 1. 工厂: transport 分发 ──────────────────────────────
  const cliChannel = createChannel({ transport: "cli", client: { health: async () => ({ ok: true, name: "mirasim" }), runTask: async () => ({ text: "hi" }) } });
  assert.strictEqual(cliChannel.name, "mirasim-cli");

  const relayChannel = createChannel({
    transport: "direct-relay",
    relayOptions: {
      token: "relay-token",
      baseURL: "https://relay.test",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "hi" }] }), text: async () => "" }),
    },
  });
  assert.strictEqual(relayChannel.name, "mirasim-relay");

  const kiroChannel = createChannel({
    transport: "kiro",
    client: {
      health: async () => ({ ok: true, name: "kiro" }),
      complete: async () => ({ text: "kiro hi", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }),
    },
  });
  assert.strictEqual(kiroChannel.name, "kiro-acp");

  assert.throws(() => createChannel({ transport: "unknown-transport" }), /unknown channel transport/);

  // ── 2. cli 通道: 工具桥协议 ──────────────────────────────
  assert.strictEqual(
    toPrompt({ messages: [{ role: "system", content: "be concise" }, { role: "user", content: "hello" }] }),
    "SYSTEM: be concise\n\nUSER: hello",
  );
  assert.throws(() => toPrompt({ messages: "nope" }), /messages must be an array/);

  const decision = parseToolDecision(JSON.stringify({
    type: "tool_call",
    tool_calls: [{ id: "call_1", name: "read_file", arguments: { path: "README.md" } }],
  }), [{ type: "function", function: { name: "read_file" } }]);
  assert.deepStrictEqual(decision, {
    type: "tool_call",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) } }],
  });
  assert.throws(() => parseToolDecision(JSON.stringify({ type: "tool_call", tool_calls: [{ name: "undeclared" }] }), [{ type: "function", function: { name: "read_file" } }]), /undeclared tool/);

  // cli 通道 complete: fake runTask → 归一化 {text, toolCalls, usage}
  const cliFake = {
    health: async () => ({ ok: true, name: "mirasim", channelConfigured: true }),
    runTask: async (task, options) => {
      const text = task.prompt.includes("TOOL_DEFINITIONS:")
        ? JSON.stringify({ type: "tool_call", tool_calls: [{ id: "call_1", name: "read_file", arguments: { path: "README.md" } }] })
        : "hello";
      options.onUpdate({ phase: "running", text: text.slice(0, 2) });
      return { text, usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
  const cli = createMirasimCliChannel({ client: cliFake, model: "mirasim-agent" });
  const cliNoTools = await cli.complete({ messages: [{ role: "user", content: "hello" }] }, { onUpdate: () => {} });
  assert.strictEqual(cliNoTools.text, "hello");
  assert.deepStrictEqual(cliNoTools.toolCalls, []);
  assert.deepStrictEqual(cliNoTools.usage, { inputTokens: 3, outputTokens: 2 });

  const cliWithTools = await cli.complete({
    messages: [{ role: "user", content: "Read README.md" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  }, { onUpdate: () => {} });
  assert.strictEqual(cliWithTools.toolCalls.length, 1);
  assert.strictEqual(cliWithTools.toolCalls[0].function.name, "read_file");

  // ── 3. relay 通道: 归一化 {text, toolCalls, usage} ───────
  const relay = createMirasimRelayChannel({
    model: "claude-opus-5",
    relayOptions: {
      token: "relay-token",
      baseURL: "https://relay.test",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "direct hello" }], usage: { input_tokens: 2, output_tokens: 3 } }), text: async () => "" }),
    },
  });
  const relayResult = await relay.complete({ messages: [{ role: "user", content: "hello" }] });
  assert.strictEqual(relayResult.text, "direct hello");
  assert.deepStrictEqual(relayResult.usage, { inputTokens: 2, outputTokens: 3 });
  assert.strictEqual(relay.name, "mirasim-relay");

  // 注入已创建 relay 实例的场景 (createGateway 传 options.relay)
  const injectedRelay = createMirasimRelayChannel({
    model: "claude-opus-5",
    relay: { health: async () => ({ ok: true, name: "injected" }), complete: async () => ({ text: "injected hello", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }) },
  });
  const injectedResult = await injectedRelay.complete({ messages: [] });
  assert.strictEqual(injectedResult.text, "injected hello");

  console.log("channel adapter selftest: PASS");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

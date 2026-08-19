"use strict";

// 中间人增益的可配置阶段链: 顺序 / 停用 / 注入 / 透传保真。

const assert = require("node:assert");
const { createAugmentation, DEFAULT_STAGE_ORDER } = require("../vendor/外接api/core/acp_augment");

const SECRET = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234567890";
function prompt(text, id = 1, sid = "s") {
  return { jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text }] } };
}

// ── 默认阶段顺序 ──
{
  const a = createAugmentation({ redact: true });
  assert.deepStrictEqual(a.stageNames(), DEFAULT_STAGE_ORDER);
  assert.deepStrictEqual(DEFAULT_STAGE_ORDER, ["inject", "redact", "monitor"]);
}

// ── 停用 redact(仅 monitor)→ 密钥不脱敏, 但仍计数 ──
{
  const events = [];
  const a = createAugmentation({ redact: true, stages: ["monitor"], onMonitor: (e) => events.push(e) });
  assert.deepStrictEqual(a.stageNames(), ["monitor"]);
  const out = a.transformOutbound(prompt(`k ${SECRET}`));
  assert.ok(JSON.stringify(out).includes(SECRET), "redact stage disabled → secret untouched");
  assert.strictEqual(a.stats().prompts, 1, "monitor still counts");
  assert.strictEqual(a.stats().redactedPrompts, 0);
}

// ── 启用 redact → 脱敏, 且未命中时返回原引用(透传保真) ──
{
  const a = createAugmentation({ redact: true });
  const dirty = prompt(`k ${SECRET}`);
  const out = a.transformOutbound(dirty);
  assert.notStrictEqual(out, dirty, "changed → new object");
  assert.ok(!JSON.stringify(out).includes(SECRET));
  const clean = prompt("hello clean");
  const out2 = a.transformOutbound(clean);
  assert.strictEqual(out2, clean, "no finding → original reference preserved (byte passthrough)");
}

// ── inject: 前缀块被前置 ──
{
  const a = createAugmentation({ injectPrefix: "SYSTEM: be concise", stages: ["inject", "monitor"] });
  const out = a.transformOutbound(prompt("hi"));
  assert.strictEqual(out.params.prompt.length, 2, "prefix block prepended");
  assert.strictEqual(out.params.prompt[0].text, "SYSTEM: be concise");
  assert.strictEqual(out.params.prompt[1].text, "hi");
}

// ── 默认顺序 inject→redact: 注入前缀里的密钥也会被扫掉 ──
{
  const a = createAugmentation({ redact: true, injectPrefix: `pre ${SECRET}` });
  assert.deepStrictEqual(a.stageNames(), ["inject", "redact", "monitor"]);
  const out = a.transformOutbound(prompt("clean body"));
  const s = JSON.stringify(out);
  assert.ok(!s.includes(SECRET), "default inject-then-redact scrubs injected secret");
  assert.ok(s.includes("clean body"));
}

// ── 自定义顺序: inject 在 redact 之前(注入的前缀也会被随后 redact 扫到) ──
{
  const a = createAugmentation({ redact: true, injectPrefix: `pre ${SECRET}`, stages: ["inject", "redact", "monitor"] });
  assert.deepStrictEqual(a.stageNames(), ["inject", "redact", "monitor"]);
  const out = a.transformOutbound(prompt("clean body"));
  const s = JSON.stringify(out);
  assert.ok(!s.includes(SECRET), "inject-then-redact: injected secret also scrubbed");
  assert.ok(s.includes("clean body"));
}

// ── 非 prompt 消息: 所有出站 stage 皆不改, 原引用透传 ──
{
  const a = createAugmentation({ redact: true, injectPrefix: "x" });
  const init = { jsonrpc: "2.0", id: 9, method: "initialize", params: {} };
  assert.strictEqual(a.transformOutbound(init), init, "non-prompt passed through untouched");
}

// ── 入站只监测不改 ──
{
  const a = createAugmentation({});
  const upd = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } };
  assert.strictEqual(a.transformInbound(upd), upd, "inbound passed through unchanged");
  assert.strictEqual(a.stats().agentChars, 2);
}

console.log("acp augment stages selftest: PASS");

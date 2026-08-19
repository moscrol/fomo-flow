"use strict";

// 运维守卫: 出站 prompt 体积/频率限流 → 中间人合成 ACP 响应回编辑器, 不转发下游。

const assert = require("node:assert");
const { createAcpProxy } = require("../vendor/外接api/core/acp_proxy");
const { createAugmentation } = require("../vendor/外接api/core/acp_augment");

function sink() {
  const lines = [];
  return {
    write: (s) => { lines.push(s); return true; },
    msgs: () => lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}
function source() {
  const h = {};
  return { on: (e, fn) => { h[e] = fn; }, feed: (s) => h.data && h.data(Buffer.from(s)), end: () => h.end && h.end() };
}
function prompt(text, id, sid = "s") {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text }] } }) + "\n";
}

// ── 体积超限: 拦下, 回编辑器 refusal + 说明, 不转发下游 ──
{
  const editorIn = source(), agentOut = source();
  const toAgent = sink(), toEditor = sink();
  const events = [];
  const aug = createAugmentation({ guard: { maxPromptChars: 10 }, onMonitor: (e) => events.push(e) });
  assert.strictEqual(aug.stageNames()[0], "guard", "guard auto-prepended to chain");
  createAcpProxy({
    editorIn, editorOut: toEditor, agentIn: toAgent, agentOut,
    transformOutbound: aug.transformOutbound, transformInbound: aug.transformInbound,
  }).start();

  editorIn.feed(prompt("this is way too long", 1)); // >10 chars
  assert.strictEqual(toAgent.msgs().length, 0, "oversized prompt NOT forwarded downstream");
  const replies = toEditor.msgs();
  const result = replies.find((m) => m.id === 1);
  assert.ok(result && result.result.stopReason === "refusal", "editor gets refusal response");
  assert.ok(replies.some((m) => m.method === "session/update" && /运维守卫/.test(JSON.stringify(m))), "explanation chunk sent to editor");
  assert.ok(events.some((e) => e.type === "guard_block"), "guard_block monitored");
}

// ── 体积未超限: 正常转发下游 ──
{
  const editorIn = source();
  const toAgent = sink();
  const aug = createAugmentation({ guard: { maxPromptChars: 1000 } });
  createAcpProxy({ editorIn, editorOut: sink(), agentIn: toAgent, agentOut: source(), transformOutbound: aug.transformOutbound }).start();
  editorIn.feed(prompt("short", 2));
  assert.strictEqual(toAgent.msgs().length, 1, "within-limit prompt forwarded");
  assert.strictEqual(toAgent.msgs()[0].id, 2);
}

// ── 频率限流: 第 N+1 条被拦 ──
{
  const editorIn = source();
  const toAgent = sink(), toEditor = sink();
  let clock = 1000;
  const aug = createAugmentation({ guard: { maxPromptsPerMin: 2 }, now: () => clock });
  createAcpProxy({ editorIn, editorOut: toEditor, agentIn: toAgent, agentOut: source(), transformOutbound: aug.transformOutbound }).start();
  editorIn.feed(prompt("a", 1));
  editorIn.feed(prompt("b", 2));
  editorIn.feed(prompt("c", 3)); // 超 2/min → 拦
  assert.strictEqual(toAgent.msgs().length, 2, "first two forwarded");
  assert.deepStrictEqual(toAgent.msgs().map((m) => m.id), [1, 2]);
  const blocked = toEditor.msgs().find((m) => m.id === 3);
  assert.ok(blocked && blocked.result.stopReason === "refusal", "3rd prompt refused");
  // 一分钟后窗口滑走 → 放行
  clock += 61000;
  editorIn.feed(prompt("d", 4));
  assert.strictEqual(toAgent.msgs().length, 3, "after window slides, forwarded again");
}

// ── 单块字符上限: 总体积合规但单个 resource 块夹带超大载荷 → 拦 ──
{
  const editorIn = source();
  const toAgent = sink(), toEditor = sink();
  const aug = createAugmentation({ guard: { maxBlockChars: 20 } });
  createAcpProxy({ editorIn, editorOut: toEditor, agentIn: toAgent, agentOut: source(), transformOutbound: aug.transformOutbound }).start();

  const big = JSON.stringify({
    jsonrpc: "2.0", id: 5, method: "session/prompt",
    params: { sessionId: "s", prompt: [
      { type: "text", text: "short ask" },
      { type: "resource", resource: { uri: "file:///x", text: "x".repeat(50) } },
    ] },
  }) + "\n";
  editorIn.feed(big);
  assert.strictEqual(toAgent.msgs().length, 0, "oversized block NOT forwarded");
  const blocked = toEditor.msgs().find((m) => m.id === 5);
  assert.ok(blocked && blocked.result.stopReason === "refusal", "refusal for oversized block");

  editorIn.feed(prompt("ok", 6)); // 单块 2 字符, 合规
  assert.strictEqual(toAgent.msgs().length, 1, "within-limit block forwarded");
}

// ── 总体积计入 resource.text: 短 text + 超大 resource 不得绕过 maxPromptChars ──
{
  const editorIn = source();
  const toAgent = sink(), toEditor = sink();
  const aug = createAugmentation({ guard: { maxPromptChars: 20 } });
  createAcpProxy({ editorIn, editorOut: toEditor, agentIn: toAgent, agentOut: source(), transformOutbound: aug.transformOutbound }).start();

  const stuffed = JSON.stringify({
    jsonrpc: "2.0", id: 9, method: "session/prompt",
    params: { sessionId: "s", prompt: [
      { type: "text", text: "hi" },
      { type: "resource", resource: { uri: "file:///x", text: "x".repeat(50) } },
    ] },
  }) + "\n";
  editorIn.feed(stuffed);
  assert.strictEqual(toAgent.msgs().length, 0, "resource stuffing must trip maxPromptChars");
  const blocked = toEditor.msgs().find((m) => m.id === 9);
  assert.ok(blocked && blocked.result.stopReason === "refusal", "refusal for resource-stuffed prompt");
  assert.ok(/prompt too large/.test(JSON.stringify(toEditor.msgs())), "reason mentions total size");
}

// ── 块数上限: 防结构层面的块洪泛 ──
{
  const editorIn = source();
  const toAgent = sink(), toEditor = sink();
  const aug = createAugmentation({ guard: { maxPromptBlocks: 2 } });
  createAcpProxy({ editorIn, editorOut: toEditor, agentIn: toAgent, agentOut: source(), transformOutbound: aug.transformOutbound }).start();

  const flood = JSON.stringify({
    jsonrpc: "2.0", id: 8, method: "session/prompt",
    params: { sessionId: "s", prompt: [
      { type: "text", text: "a" }, { type: "text", text: "b" }, { type: "text", text: "c" },
    ] },
  }) + "\n";
  editorIn.feed(flood);
  assert.strictEqual(toAgent.msgs().length, 0, "block flood NOT forwarded");
  const blocked = toEditor.msgs().find((m) => m.id === 8);
  assert.ok(blocked && blocked.result.stopReason === "refusal", "refusal for block flood");
  assert.ok(/too many prompt blocks/.test(JSON.stringify(toEditor.msgs())), "reason mentions block count");
}

// ── 未配守卫: 默认链无 guard, 不影响 ──
{
  const aug = createAugmentation({ redact: true });
  assert.ok(!aug.stageNames().includes("guard"), "no guard by default");
}

console.log("acp guard selftest: PASS");

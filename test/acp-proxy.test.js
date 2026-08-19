"use strict";

// P/ACP 中间人代理: 透传保真 + 出站 prompt 增益(脱敏) + 监测 + 工具调用透传。

const assert = require("node:assert");
const { createAcpProxy } = require("../vendor/外接api/core/acp_proxy");
const { createAugmentation } = require("../vendor/外接api/core/acp_augment");

// 简易可写流收集器
function sink() {
  const lines = [];
  return {
    write: (s) => { lines.push(s); return true; },
    raw: () => lines.join(""),
    msgs: () => lines.join("").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return { __raw: l }; } }),
  };
}
// 简易可读流(手动 feed)
function source() {
  const handlers = {};
  return {
    on: (ev, fn) => { handlers[ev] = fn; },
    feed: (s) => handlers.data && handlers.data(Buffer.from(s)),
    end: () => handlers.end && handlers.end(),
  };
}

(async () => {
  // ── 透传保真: 未匹配的消息原样转发(工具调用/权限/update 不改) ──
  {
    const editorIn = source(), agentOut = source();
    const toAgent = sink(), toEditor = sink();
    const aug = createAugmentation({ redact: true });
    createAcpProxy({
      editorIn, editorOut: toEditor, agentIn: toAgent, agentOut,
      transformOutbound: aug.transformOutbound, transformInbound: aug.transformInbound,
    }).start();

    // 出站: initialize(非 prompt)应原样透传
    editorIn.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }) + "\n");
    // 入站: agent 的工具调用 update 应原样透传(中间人不碰工具)
    const toolCall = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "read_file", status: "pending" } } };
    agentOut.feed(JSON.stringify(toolCall) + "\n");

    assert.deepStrictEqual(toAgent.msgs()[0].method, "initialize", "initialize passed through to agent");
    assert.deepStrictEqual(toEditor.msgs()[0], toolCall, "tool_call update passed through untouched");
  }

  // ── 出站 session/prompt 脱敏增益 ──
  {
    const editorIn = source(), agentOut = source();
    const toAgent = sink(), toEditor = sink();
    const events = [];
    const aug = createAugmentation({ redact: true, redactMode: "redact", onMonitor: (e) => events.push(e) });
    createAcpProxy({
      editorIn, editorOut: toEditor, agentIn: toAgent, agentOut,
      transformOutbound: aug.transformOutbound, transformInbound: aug.transformInbound,
    }).start();

    const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234567890";
    editorIn.feed(JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "session/prompt",
      params: { sessionId: "s", prompt: [{ type: "text", text: `use key ${secret}` }] },
    }) + "\n");

    const fwd = toAgent.msgs()[0];
    const sent = JSON.stringify(fwd);
    assert.ok(!sent.includes(secret), "secret redacted before reaching downstream agent");
    assert.ok(sent.includes("«redacted:openai_key»"), "placeholder present");
    const promptEvent = events.find((e) => e.type === "prompt");
    assert.ok(promptEvent && promptEvent.redacted === true, "monitor recorded redaction");
    assert.deepStrictEqual(aug.stats().redactedPrompts, 1);
  }

  // ── 无增益命中时透传原字节(不重序列化) ──
  {
    const editorIn = source();
    const toAgent = sink();
    const aug = createAugmentation({ redact: true });
    createAcpProxy({ editorIn, editorOut: sink(), agentIn: toAgent, agentOut: source(), transformOutbound: aug.transformOutbound }).start();
    // 故意用非规范空格的 JSON, 验证未改动时原样透传
    const rawLine = '{"jsonrpc":"2.0",  "id":3,"method":"session/prompt","params":{"sessionId":"s","prompt":[{"type":"text","text":"hello clean"}]}}';
    editorIn.feed(rawLine + "\n");
    assert.strictEqual(toAgent.raw(), rawLine + "\n", "unchanged prompt forwarded byte-for-byte");
  }

  // ── 非 JSON 行 / 空行 原样透传, 不拦 ──
  {
    const editorIn = source();
    const toAgent = sink();
    createAcpProxy({ editorIn, editorOut: sink(), agentIn: toAgent, agentOut: source(), transformOutbound: (m) => m }).start();
    editorIn.feed("not json\n\n");
    assert.strictEqual(toAgent.raw(), "not json\n\n", "non-JSON and blank lines passed through");
  }

  // ── drop: transform 返回 {drop:true} 不转发 ──
  {
    const editorIn = source();
    const toAgent = sink();
    createAcpProxy({
      editorIn, editorOut: sink(), agentIn: toAgent, agentOut: source(),
      transformOutbound: (m) => (m.method === "spam" ? { drop: true } : m),
    }).start();
    editorIn.feed(JSON.stringify({ jsonrpc: "2.0", method: "spam" }) + "\n");
    editorIn.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "keep" }) + "\n");
    const msgs = toAgent.msgs();
    assert.strictEqual(msgs.length, 1, "dropped message not forwarded");
    assert.strictEqual(msgs[0].method, "keep");
  }

  // ── transform 抛错 → 安全透传原消息 ──
  {
    const editorIn = source();
    const toAgent = sink();
    createAcpProxy({
      editorIn, editorOut: sink(), agentIn: toAgent, agentOut: source(),
      transformOutbound: () => { throw new Error("boom"); },
    }).start();
    editorIn.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" }) + "\n");
    assert.strictEqual(toAgent.msgs()[0].method, "x", "transform error → original passed through");
  }

  // ── 入站监测: agent_message_chunk 计字符, stopReason 计轮次 ──
  {
    const agentOut = source();
    const toEditor = sink();
    const aug = createAugmentation({});
    createAcpProxy({ editorIn: source(), editorOut: toEditor, agentIn: sink(), agentOut, transformInbound: aug.transformInbound }).start();
    agentOut.feed(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } }) + "\n");
    agentOut.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } }) + "\n");
    assert.strictEqual(aug.stats().agentChars, 5);
    assert.strictEqual(aug.stats().turns, 1);
    // 两条都应透传给编辑器
    assert.strictEqual(toEditor.msgs().length, 2, "inbound messages passed through");
  }

  console.log("acp proxy selftest: PASS");
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

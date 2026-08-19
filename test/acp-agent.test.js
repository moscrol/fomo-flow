"use strict";

// dao-flow 作为标准 ACP agent 的最小握手 + 一轮对话(传输可注入 · 无进程/网络)。

const assert = require("node:assert");
const { createAcpAgent, PROTOCOL_VERSION } = require("../vendor/外接api/core/acp_agent");

function collector() {
  const lines = [];
  return {
    output: { write: (s) => { lines.push(s); return true; } },
    input: { on() {}, off() {} },
    messages: () => lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

(async () => {
  // ── initialize 握手 ──
  {
    const c = collector();
    const agent = createAcpAgent({ input: c.input, output: c.output, agentVersion: "9.9" });
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const [resp] = c.messages();
    assert.strictEqual(resp.id, 1);
    assert.strictEqual(resp.result.protocolVersion, PROTOCOL_VERSION);
    assert.strictEqual(resp.result.agentInfo.name, "fomo-flow");
    assert.strictEqual(resp.result.agentInfo.version, "9.9");
    assert.deepStrictEqual(resp.result.authMethods, []);
  }

  // ── session/new → sessionId ──
  {
    const c = collector();
    const agent = createAcpAgent({ input: c.input, output: c.output, genId: () => "sess_fixed" });
    await agent.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/proj", mcpServers: [] } });
    const [resp] = c.messages();
    assert.strictEqual(resp.result.sessionId, "sess_fixed");
    assert.ok(agent.sessions.has("sess_fixed"));
  }

  // ── session/prompt: 流式 chunk + stopReason ──
  {
    const c = collector();
    const seen = [];
    const agent = createAcpAgent({
      input: c.input,
      output: c.output,
      genId: () => "sess_1",
      complete: async ({ messages, onChunk }) => {
        seen.push(messages[0].content);
        onChunk("Hello");
        onChunk(", world");
        return { stopReason: "end_turn" };
      },
    });
    await agent.handle({ jsonrpc: "2.0", id: 3, method: "session/new", params: {} });
    await agent.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { sessionId: "sess_1", prompt: [{ type: "text", text: "hi there" }] },
    });
    const msgs = c.messages();
    assert.strictEqual(seen[0], "hi there", "prompt text extracted & passed to complete");
    const updates = msgs.filter((m) => m.method === "session/update");
    assert.strictEqual(updates.length, 2, "two streaming chunks emitted");
    assert.strictEqual(updates[0].params.update.sessionUpdate, "agent_message_chunk");
    assert.strictEqual(updates[0].params.update.content.text, "Hello");
    assert.strictEqual(updates[1].params.update.content.text, ", world");
    const final = msgs.find((m) => m.id === 4);
    assert.strictEqual(final.result.stopReason, "end_turn");
  }

  // ── prompt 到未知 session → error ──
  {
    const c = collector();
    const agent = createAcpAgent({ input: c.input, output: c.output, complete: async () => ({ stopReason: "end_turn" }) });
    await agent.handle({ jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId: "nope", prompt: [] } });
    const [resp] = c.messages();
    assert.ok(resp.error && resp.error.code === -32602, "unknown session → invalid params error");
  }

  // ── cancel: complete 观察到取消 → stopReason cancelled ──
  {
    const c = collector();
    const agent = createAcpAgent({
      input: c.input,
      output: c.output,
      genId: () => "sess_c",
      complete: async ({ sessionId, isCancelled, onChunk }) => {
        // 模拟推理中途收到 cancel
        await agent.handle({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
        onChunk("partial");
        assert.strictEqual(isCancelled(), true, "complete sees cancellation");
        return { stopReason: "end_turn" };
      },
    });
    await agent.handle({ jsonrpc: "2.0", id: 6, method: "session/new", params: {} });
    await agent.handle({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId: "sess_c", prompt: "go" } });
    const final = c.messages().find((m) => m.id === 7);
    assert.strictEqual(final.result.stopReason, "cancelled", "cancel overrides stopReason");
  }

  // ── 未知方法(带 id)→ method not found ──
  {
    const c = collector();
    const agent = createAcpAgent({ input: c.input, output: c.output });
    await agent.handle({ jsonrpc: "2.0", id: 8, method: "bogus/method", params: {} });
    const [resp] = c.messages();
    assert.strictEqual(resp.error.code, -32601);
  }

  // ── complete 抛错: refusal, 错误文本不入历史 ──
  {
    const c = collector();
    const agent = createAcpAgent({
      input: c.input,
      output: c.output,
      genId: () => "sess_err",
      complete: async () => {
        throw new Error("upstream 500");
      },
    });
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await agent.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "sess_err", prompt: "q" },
    });
    const final = c.messages().find((m) => m.id === 2);
    assert.strictEqual(final.result.stopReason, "refusal");
    const hist = agent.sessions.get("sess_err").messages;
    assert.ok(!hist.some((m) => m.role === "assistant"), "error text not persisted as assistant");
  }

  // ── 同 session 并发 prompt: 必须串行, 第二轮看到第一轮 assistant ──
  {
    const c = collector();
    const turns = [];
    let releaseFirst;
    const firstGate = new Promise((r) => {
      releaseFirst = r;
    });
    const agent = createAcpAgent({
      input: c.input,
      output: c.output,
      genId: () => "sess_lock",
      complete: async ({ messages, onChunk }) => {
        turns.push(messages.map((m) => `${m.role}:${m.content}`));
        if (messages[messages.length - 1].content === "one") await firstGate;
        onChunk("ok");
        return { stopReason: "end_turn" };
      },
    });
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    const p1 = agent.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "sess_lock", prompt: "one" },
    });
    const p2 = agent.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "sess_lock", prompt: "two" },
    });
    await new Promise((r) => setImmediate(r));
    releaseFirst();
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(turns[0], ["user:one"]);
    assert.deepStrictEqual(
      turns[1],
      ["user:one", "assistant:ok", "user:two"],
      "concurrent prompts must serialize so turn 2 sees turn 1 assistant",
    );
  }

  // ── stdio 同一 chunk 两行 prompt 也必须串行 ──
  {
    const lines = [];
    const handlers = {};
    const turns = [];
    let releaseFirst;
    const firstGate = new Promise((r) => {
      releaseFirst = r;
    });
    const agent = createAcpAgent({
      input: {
        on(ev, fn) {
          handlers[ev] = fn;
        },
        off() {},
      },
      output: {
        write(s) {
          lines.push(s);
          return true;
        },
      },
      genId: () => "sess_stdio",
      complete: async ({ messages, onChunk }) => {
        turns.push(messages.map((m) => `${m.role}:${m.content}`));
        if (messages[messages.length - 1].content === "one") await firstGate;
        onChunk("ok");
        return { stopReason: "end_turn" };
      },
    });
    agent.start();
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    handlers.data(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/prompt",
          params: { sessionId: "sess_stdio", prompt: "one" },
        }) +
          "\n" +
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "session/prompt",
            params: { sessionId: "sess_stdio", prompt: "two" },
          }) +
          "\n",
      ),
    );
    await new Promise((r) => setImmediate(r));
    releaseFirst();
    let msgs = [];
    for (let i = 0; i < 50; i++) {
      msgs = lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      if (msgs.some((m) => m.id === 2) && msgs.some((m) => m.id === 3)) break;
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(
      msgs.some((m) => m.id === 2) && msgs.some((m) => m.id === 3),
      "both stdio prompts must complete",
    );
    assert.deepStrictEqual(turns[0], ["user:one"]);
    assert.deepStrictEqual(
      turns[1],
      ["user:one", "assistant:ok", "user:two"],
      "stdio same-chunk prompts must serialize",
    );
  }

  // ── promptText: 从 content blocks 抽文本 ──
  {
    const agent = createAcpAgent({ input: { on() {} }, output: { write() {} } });
    assert.strictEqual(agent.promptText("plain"), "plain");
    assert.strictEqual(
      agent.promptText([{ type: "text", text: "a" }, { type: "image" }, { type: "resource", resource: { text: "b" } }]),
      "a\nb",
    );
  }

  console.log("acp agent selftest: PASS");
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});

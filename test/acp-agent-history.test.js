"use strict";

// ACP agent 深化: 多轮会话历史(上下文)+ session/load 恢复回放 + 可选持久化。

const assert = require("node:assert");
const { createAcpAgent } = require("../vendor/外接api/core/acp_agent");

function collector() {
  const lines = [];
  return {
    output: { write: (s) => { lines.push(s); return true; } },
    input: { on() {}, off() {} },
    messages: () => lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    clear: () => { lines.length = 0; },
  };
}

(async () => {
  // ── 多轮: 第二轮 complete 应看到含首轮 user+assistant 的完整历史 ──
  {
    const c = collector();
    const turns = [];
    let reply = "A1";
    const agent = createAcpAgent({
      input: c.input,
      output: c.output,
      genId: () => "s1",
      complete: async ({ messages, onChunk }) => {
        turns.push(messages.map((m) => `${m.role}:${m.content}`));
        onChunk(reply);
        return { stopReason: "end_turn" };
      },
    });
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await agent.handle({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s1", prompt: "one" } });
    reply = "A2";
    await agent.handle({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: "two" } });

    assert.deepStrictEqual(turns[0], ["user:one"], "turn 1 sees only its own message");
    assert.deepStrictEqual(
      turns[1],
      ["user:one", "assistant:A1", "user:two"],
      "turn 2 sees full prior history (multi-turn context)",
    );
    assert.deepStrictEqual(
      agent.sessions.get("s1").messages.map((m) => `${m.role}:${m.content}`),
      ["user:one", "assistant:A1", "user:two", "assistant:A2"],
      "history accumulates user+assistant across turns",
    );
  }

  // ── initialize 广告 loadSession 能力 ──
  {
    const c = collector();
    const agent = createAcpAgent({ input: c.input, output: c.output });
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.strictEqual(c.messages()[0].result.agentCapabilities.loadSession, true);
  }

  // ── session/load 回放内存中会话历史 ──
  {
    const c = collector();
    const agent = createAcpAgent({
      input: c.input, output: c.output, genId: () => "s2",
      complete: async ({ onChunk }) => { onChunk("hi"); return { stopReason: "end_turn" }; },
    });
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await agent.handle({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s2", prompt: "q" } });
    c.clear();
    await agent.handle({ jsonrpc: "2.0", id: 3, method: "session/load", params: { sessionId: "s2", cwd: "/p", mcpServers: [] } });
    const msgs = c.messages();
    const updates = msgs.filter((m) => m.method === "session/update");
    assert.strictEqual(updates.length, 2, "replays user + assistant");
    assert.strictEqual(updates[0].params.update.sessionUpdate, "user_message_chunk");
    assert.strictEqual(updates[0].params.update.content.text, "q");
    assert.strictEqual(updates[1].params.update.sessionUpdate, "agent_message_chunk");
    assert.strictEqual(updates[1].params.update.content.text, "hi");
    const resp = msgs.find((m) => m.id === 3);
    assert.deepStrictEqual(resp.result, {}, "load responds with empty result");
  }

  // ── session/load 未知 session 且无存储 → 错误 ──
  {
    const c = collector();
    const agent = createAcpAgent({ input: c.input, output: c.output });
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "ghost" } });
    assert.strictEqual(c.messages()[0].error.code, -32602);
  }

  // ── 持久化存储: 每轮 save; load 跨"进程"从存储恢复并回放 ──
  {
    const disk = new Map();
    const store = {
      save: (sid, messages) => disk.set(sid, JSON.parse(JSON.stringify(messages))),
      load: (sid) => disk.get(sid) || null,
    };
    // 进程 A: 建会话 + 一轮
    const a = collector();
    const agentA = createAcpAgent({
      input: a.input, output: a.output, genId: () => "s3", store,
      complete: async ({ onChunk }) => { onChunk("ans"); return { stopReason: "end_turn" }; },
    });
    await agentA.handle({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await agentA.handle({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s3", prompt: "hello" } });
    assert.ok(disk.has("s3"), "history persisted to store");
    assert.deepStrictEqual(
      disk.get("s3").map((m) => `${m.role}:${m.content}`),
      ["user:hello", "assistant:ans"],
    );

    // 进程 B: 全新 agent 实例(内存空), session/load 从存储恢复并回放
    const b = collector();
    const agentB = createAcpAgent({ input: b.input, output: b.output, store });
    await agentB.handle({ jsonrpc: "2.0", id: 9, method: "session/load", params: { sessionId: "s3" } });
    const updates = b.messages().filter((m) => m.method === "session/update");
    assert.strictEqual(updates.length, 2, "restored history replayed cross-process");
    assert.ok(agentB.sessions.has("s3"), "session re-registered in new instance");
  }

  // ── 有界历史: 超上限裁中段, 保首条 ──
  {
    const c = collector();
    const agent = createAcpAgent({
      input: c.input, output: c.output, genId: () => "s4", maxHistoryMessages: 4,
      complete: async ({ onChunk }) => { onChunk("r"); return { stopReason: "end_turn" }; },
    });
    await agent.handle({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    for (let i = 0; i < 5; i++) {
      await agent.handle({ jsonrpc: "2.0", id: 10 + i, method: "session/prompt", params: { sessionId: "s4", prompt: "m" + i } });
    }
    const hist = agent.sessions.get("s4").messages;
    assert.ok(hist.length <= 4 + 1, "history bounded (allows final assistant append)");
    assert.strictEqual(hist[0].content, "m0", "first message preserved as anchor");
  }

  console.log("acp agent history/load selftest: PASS");
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

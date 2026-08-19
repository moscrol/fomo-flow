"use strict";

// ACP 中间人监测 → 每轮 trace 关联 (供 OTEL 导出)。

const assert = require("node:assert");
const { createAcpMonitor } = require("../vendor/外接api/core/acp_monitor");

(async () => {
  // ── 一轮: prompt → chunks → turn_complete 汇成一条 trace ──
  {
    const traces = [];
    let t = 1000;
    const mon = createAcpMonitor({ onTrace: (tr) => traces.push(tr), now: () => (t += 5) });
    mon.handleEvent({ type: "prompt", id: 1, sessionId: "s", chars: 20, blocks: 1, redacted: true, findings: ["openai_key"] });
    mon.handleEvent({ type: "agent_chunk", sessionId: "s", chars: 3 });
    mon.handleEvent({ type: "agent_chunk", sessionId: "s", chars: 4 });
    mon.handleEvent({ type: "turn_complete", id: 1, stopReason: "end_turn" });

    assert.strictEqual(traces.length, 1, "one trace per turn");
    const tr = traces[0];
    assert.strictEqual(tr.status, "ok");
    assert.strictEqual(tr.modelUid, "acp:s");
    assert.strictEqual(tr.steps.length, 2, "prompt + turn_complete steps");
    assert.strictEqual(tr.steps[0].type, "prompt");
    assert.strictEqual(tr.steps[0].redacted, true);
    assert.strictEqual(tr.steps[0].findings, "openai_key");
    assert.strictEqual(tr.steps[1].type, "turn_complete");
    assert.strictEqual(tr.steps[1].agentChars, 7, "accumulated agent output chars");
    assert.ok(tr.durationMs >= 0);
    assert.strictEqual(mon.inflight(), 0, "turn cleaned up");
  }

  // ── cancelled → status failed ──
  {
    const traces = [];
    const mon = createAcpMonitor({ onTrace: (tr) => traces.push(tr) });
    mon.handleEvent({ type: "prompt", id: 2, sessionId: "s2", chars: 5 });
    mon.handleEvent({ type: "turn_complete", id: 2, stopReason: "cancelled" });
    assert.strictEqual(traces[0].status, "failed");
    assert.ok(traces[0].summary.includes("cancelled"));
  }

  // ── 两个会话交错: 按 id 正确关联, 各出一条 ──
  {
    const traces = [];
    const mon = createAcpMonitor({ onTrace: (tr) => traces.push(tr) });
    mon.handleEvent({ type: "prompt", id: 10, sessionId: "A", chars: 1 });
    mon.handleEvent({ type: "prompt", id: 11, sessionId: "B", chars: 1 });
    mon.handleEvent({ type: "agent_chunk", sessionId: "B", chars: 9 });
    mon.handleEvent({ type: "agent_chunk", sessionId: "A", chars: 2 });
    mon.handleEvent({ type: "turn_complete", id: 11, stopReason: "end_turn" });
    mon.handleEvent({ type: "turn_complete", id: 10, stopReason: "end_turn" });
    assert.strictEqual(traces.length, 2);
    const byModel = Object.fromEntries(traces.map((t) => [t.modelUid, t]));
    assert.strictEqual(byModel["acp:B"].steps[1].agentChars, 9, "B chunks attributed to B");
    assert.strictEqual(byModel["acp:A"].steps[1].agentChars, 2, "A chunks attributed to A");
  }

  // ── 无匹配 prompt 的 turn_complete / chunk 安全忽略 ──
  {
    const traces = [];
    const mon = createAcpMonitor({ onTrace: (tr) => traces.push(tr) });
    mon.handleEvent({ type: "turn_complete", id: 99, stopReason: "end_turn" });
    mon.handleEvent({ type: "agent_chunk", sessionId: "ghost", chars: 5 });
    assert.strictEqual(traces.length, 0, "orphan events ignored");
  }

  // ── 组合: monitor → OTEL 导出器, ACP 每轮成为 OTLP span ──
  {
    const { createOtelExporter } = require("../vendor/外接api/core/otel_export");
    const sent = [];
    const exporter = createOtelExporter({
      endpoint: "http://collector",
      serviceName: "dao-flow-acp",
      batchSize: 1,
      httpPost: (url, headers, body) => { sent.push(JSON.parse(body)); return Promise.resolve(); },
    });
    const mon = createAcpMonitor({ onTrace: (tr) => exporter.exportTrace(tr) });
    mon.handleEvent({ type: "prompt", id: 1, sessionId: "s", chars: 12, redacted: true, findings: ["jwt"] });
    mon.handleEvent({ type: "agent_chunk", sessionId: "s", chars: 8 });
    mon.handleEvent({ type: "turn_complete", id: 1, stopReason: "end_turn" });
    await exporter.flush();
    assert.ok(sent.length >= 1, "OTLP payload posted for the ACP turn");
    const span = sent[0].resourceSpans[0].scopeSpans[0].spans[0];
    assert.strictEqual(span.name, "dao.route acp:s", "span named for the ACP session");
    assert.strictEqual(span.status.code, 1, "end_turn → OK");
    assert.ok(span.events.some((e) => e.name === "prompt"), "prompt step as span event");
    assert.ok(span.events.some((e) => e.name === "turn_complete"), "turn_complete step as span event");
    exporter.dispose();
  }

  console.log("acp monitor selftest: PASS");
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

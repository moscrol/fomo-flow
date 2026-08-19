"use strict";

const assert = require("node:assert");
const { createOtelExporter } = require("../vendor/外接api/core/otel_export");
const traceCenter = require("../vendor/外接api/core/trace_center");

function sampleTrace(overrides) {
  return Object.assign(
    {
      id: 7,
      at: 1_700_000_000_000,
      modelUid: "claude-x",
      status: "ok",
      durationMs: 1234,
      summary: "done",
      steps: [
        { at: 1_700_000_000_010, elapsedMs: 10, type: "route_entry", provider: "p", attempt: 1 },
        { at: 1_700_000_000_500, elapsedMs: 500, type: "attempt_failed", ok: false },
      ],
    },
    overrides || {},
  );
}

// ── OTLP 结构映射: 1 span + steps 映射为 events ──
{
  const sent = [];
  const exp = createOtelExporter({
    endpoint: "http://collector.local",
    serviceName: "dao-flow-test",
    batchSize: 1, // 立即 flush
    httpPost: (url, headers, body) => {
      sent.push({ url, headers, body: JSON.parse(body) });
      return Promise.resolve();
    },
  });
  exp.exportTrace(sampleTrace());
  // batchSize=1 → 同步触发 flush (异步 post); 等微任务
  return Promise.resolve().then(async () => {
    await exp.flush();
    assert.strictEqual(sent.length >= 1, true, "posted at least once");
    const call = sent[0];
    assert.ok(call.url.endsWith("/v1/traces"), "posts to /v1/traces");
    const rs = call.body.resourceSpans[0];
    assert.strictEqual(
      rs.resource.attributes[0].value.stringValue,
      "dao-flow-test",
      "service.name set",
    );
    const span = rs.scopeSpans[0].spans[0];
    assert.strictEqual(span.name, "dao.route claude-x");
    assert.match(span.traceId, /^[a-f0-9]{32}$/, "traceId 16 bytes hex");
    assert.match(span.spanId, /^[a-f0-9]{16}$/, "spanId 8 bytes hex");
    assert.strictEqual(span.startTimeUnixNano, "1700000000000000000", "ms→ns");
    assert.strictEqual(span.endTimeUnixNano, "1700000001234000000", "end = start+duration");
    assert.strictEqual(span.status.code, 1, "ok → status code 1");
    assert.strictEqual(span.events.length, 2, "steps mapped to events");
    assert.strictEqual(span.events[0].name, "route_entry");
    const attrKeys = span.events[0].attributes.map((a) => a.key);
    assert.ok(attrKeys.includes("dao.provider"), "step string attr");
    assert.ok(attrKeys.includes("dao.attempt"), "step int attr");

    // ── failed 状态 → code 2 ──
    sent.length = 0;
    exp.exportTrace(sampleTrace({ status: "failed" }));
    await exp.flush();
    assert.strictEqual(
      sent[0].body.resourceSpans[0].scopeSpans[0].spans[0].status.code,
      2,
      "failed → status code 2",
    );

    const snap = exp.snapshot();
    assert.ok(snap.exported >= 2, "exported counter tracks");
    exp.dispose();

    await testBatching();
    await testNoEndpoint();
    testTraceCenterHook();
    console.log("otel export selftest: PASS");
  });
}

// ── 批量: 未达 batchSize 不发, flush 才发 ──
async function testBatching() {
  const sent = [];
  const exp = createOtelExporter({
    endpoint: "http://c",
    batchSize: 5,
    flushIntervalMs: 0, // 关定时 flush
    httpPost: (u, h, b) => {
      sent.push(JSON.parse(b));
      return Promise.resolve();
    },
  });
  exp.exportTrace(sampleTrace());
  exp.exportTrace(sampleTrace());
  assert.strictEqual(sent.length, 0, "below batch size → not sent yet");
  assert.strictEqual(exp.snapshot().buffered, 2, "buffered count");
  await exp.flush();
  assert.strictEqual(sent.length, 1, "flush sends batched");
  assert.strictEqual(sent[0].resourceSpans[0].scopeSpans[0].spans.length, 2, "2 spans batched");
  exp.dispose();
}

// ── 无端点: 不崩, 丢弃计数 ──
async function testNoEndpoint() {
  const exp = createOtelExporter({ endpoint: "", batchSize: 5, flushIntervalMs: 0 });
  exp.exportTrace(sampleTrace());
  const r = await exp.flush();
  assert.strictEqual(r.ok, false, "no endpoint → not ok");
  assert.strictEqual(r.reason, "no-endpoint");
  assert.ok(exp.snapshot().dropped >= 1, "dropped counted");
  exp.dispose();
}

// ── trace_center.onFinish 钩子: end() 触发订阅 ──
function testTraceCenterHook() {
  traceCenter.clear();
  const finished = [];
  const off = traceCenter.onFinish((t) => finished.push(t));
  const tr = traceCenter.begin({ modelUid: "m1" });
  tr.step("route_entry", { provider: "p" });
  assert.strictEqual(finished.length, 0, "no emit before end");
  tr.end("ok", "done");
  assert.strictEqual(finished.length, 1, "onFinish fired on end");
  assert.strictEqual(finished[0].modelUid, "m1");
  assert.strictEqual(finished[0].status, "ok");
  assert.strictEqual(finished[0].steps.length, 1);
  // 二次 end 不重复触发
  tr.end("ok");
  assert.strictEqual(finished.length, 1, "end is idempotent");
  // 取消订阅后不再触发
  off();
  const tr2 = traceCenter.begin({ modelUid: "m2" });
  tr2.end("ok");
  assert.strictEqual(finished.length, 1, "unsubscribed no longer fires");
  traceCenter.clear();
}

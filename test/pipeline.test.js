"use strict";

const assert = require("node:assert");
const { createConductor } = require("../vendor/外接api/core/pipeline");

// ── 出站正序穿过, ctx 逐阶段改写 ──
{
  const order = [];
  const c = createConductor([
    { name: "a", outbound: (ctx) => { order.push("a"); return { ctx: { ...ctx, n: ctx.n + 1 } }; } },
    { name: "b", outbound: (ctx) => { order.push("b"); return { ctx: { ...ctx, n: ctx.n * 10 } }; } },
  ]);
  const r = c.runOutbound({ n: 1 });
  assert.deepStrictEqual(order, ["a", "b"], "outbound runs in order");
  assert.strictEqual(r.ctx.n, 20, "(1+1)*10 = 20");
  assert.strictEqual(r.blocked, undefined);
  assert.strictEqual(r.shortCircuit, undefined);
}

// ── 无返回值的阶段 = 跳过, 不改 ctx ──
{
  const c = createConductor([
    { name: "noop", outbound: () => undefined },
    { name: "set", outbound: (ctx) => ({ ctx: { ...ctx, v: 9 } }) },
  ]);
  const r = c.runOutbound({ v: 0 });
  assert.strictEqual(r.ctx.v, 9);
  assert.ok(r.trace.some((t) => t.stage === "noop" && t.applied === false));
}

// ── block: 停止后续 ──
{
  const seen = [];
  const c = createConductor([
    { name: "guard", outbound: () => ({ block: { reason: "policy" } }) },
    { name: "after", outbound: () => { seen.push("after"); return undefined; } },
  ]);
  const r = c.runOutbound({});
  assert.ok(r.blocked, "blocked set");
  assert.strictEqual(r.blocked.stage, "guard");
  assert.strictEqual(r.blocked.reason, "policy");
  assert.strictEqual(seen.length, 0, "stages after block do not run");
}

// ── shortCircuit: 停止后续 + 携带返回 (如缓存命中) ──
{
  const c = createConductor([
    { name: "cache", outbound: () => ({ shortCircuit: { response: "cached" } }) },
    { name: "upstream", outbound: () => { throw new Error("should not run"); } },
  ]);
  const r = c.runOutbound({});
  assert.ok(r.shortCircuit);
  assert.strictEqual(r.shortCircuit.response, "cached");
}

// ── 入站逆序穿过 ──
{
  const order = [];
  const c = createConductor([
    { name: "a", inbound: (ctx) => { order.push("a"); return { ctx }; } },
    { name: "b", inbound: (ctx) => { order.push("b"); return { ctx }; } },
  ]);
  c.runInbound({});
  assert.deepStrictEqual(order, ["b", "a"], "inbound runs in reverse order");
}

// ── 软错误: 阶段抛异常被吞, 继续后续 ──
{
  const c = createConductor([
    { name: "boom", outbound: () => { throw new Error("x"); } },
    { name: "ok", outbound: (ctx) => ({ ctx: { ...ctx, ok: true } }) },
  ]);
  const r = c.runOutbound({});
  assert.strictEqual(r.ctx.ok, true, "pipeline continues after soft stage error");
  assert.ok(r.trace.some((t) => t.stage === "boom" && t.error));
}

// ── hard 阶段异常向上抛 ──
{
  const c = createConductor([
    { name: "critical", hard: true, outbound: () => { throw new Error("fatal"); } },
  ]);
  assert.throws(() => c.runOutbound({}), /fatal/, "hard stage error propagates");
}

// ── stageNames / 过滤非法阶段 ──
{
  const c = createConductor([{ name: "x", outbound: () => undefined }, null, { noName: true }]);
  assert.deepStrictEqual(c.stageNames(), ["x"], "invalid stages filtered out");
}

console.log("pipeline conductor selftest: PASS");

"use strict";

const assert = require("node:assert");
const { nearestRank, summarizeSamples } = require("../core/ttft_metrics.js");

assert.strictEqual(nearestRank([400, 100, 300, 200], 0.5), 200);
assert.strictEqual(nearestRank([400, 100, 300, 200], 0.95), 400);
assert.strictEqual(nearestRank([], 0.95), null);

const summary = summarizeSamples([
  {
    success: true,
    firstSignalKind: "text",
    ttftMs: 100,
    durationMs: 900,
    cached: 80,
    input: 100,
  },
  {
    success: true,
    firstSignalKind: "tool",
    ttftMs: 200,
    durationMs: 1000,
    cached: 0,
    input: 100,
  },
  {
    success: true,
    firstSignalKind: "text",
    ttftMs: 400,
    durationMs: 1200,
    cached: 50,
    input: 100,
  },
  {
    success: false,
    firstSignalKind: "none",
    ttftMs: 0,
    durationMs: 2000,
    cached: 0,
    input: 0,
  },
  {
    success: true,
    firstSignalKind: "none",
    ttftMs: 0,
    durationMs: 100,
    cached: 0,
    input: 0,
  },
]);

assert.deepStrictEqual(summary.overall, {
  count: 3,
  p50TtftMs: 200,
  p95TtftMs: 400,
  minTtftMs: 100,
  maxTtftMs: 400,
  p50DurationMs: 1000,
  p95DurationMs: 1200,
});
assert.strictEqual(summary.cache.hit.count, 2);
assert.strictEqual(summary.cache.hit.p95TtftMs, 400);
assert.strictEqual(summary.cache.miss.count, 1);
assert.strictEqual(summary.cache.miss.p95TtftMs, 200);
assert.strictEqual(summary.cache.unknown.count, 0);
assert(!JSON.stringify(summary).includes("prompt"));

const unknown = summarizeSamples([
  {
    success: true,
    firstSignalKind: "text",
    ttftMs: 50,
    durationMs: 70,
    input: 0,
    cached: 0,
    privateText: "must-not-escape",
  },
]);
assert.strictEqual(unknown.cache.unknown.count, 1);
assert(!JSON.stringify(unknown).includes("must-not-escape"));

const unconfirmed = summarizeSamples([
  { firstSignalKind: "text", ttftMs: 10, durationMs: 20, input: 1, cached: 1 },
  { success: true, firstSignalKind: "text", ttftMs: 0, durationMs: 20, input: 1, cached: 1 },
]);
assert.strictEqual(
  unconfirmed.overall.count,
  0,
  "only explicit successful non-zero first-visible samples are observed",
);

const bounded = summarizeSamples(Array.from({ length: 60 }, (_, index) => ({
  success: true,
  firstSignalKind: "text",
  ttftMs: index + 1,
  durationMs: index + 101,
  input: 100,
  cached: index % 2 ? 50 : 0,
  provider: index < 30 ? "alpha" : "beta",
  model: index < 30 ? "model-a" : "model-b",
  source: index < 30 ? "cascade" : "codex",
})));
assert.strictEqual(bounded.overall.count, 50, "global aggregation keeps the newest 50 samples");
assert.strictEqual(bounded.overall.minTtftMs, 11);
assert.strictEqual(bounded.groups.provider.alpha.overall.count, 20);
assert.strictEqual(bounded.groups.provider.beta.overall.count, 20);
assert.strictEqual(bounded.groups.model["model-b"].overall.count, 20);
assert.strictEqual(bounded.groups.source.codex.overall.count, 20);

console.log("ttft metrics: PASS");

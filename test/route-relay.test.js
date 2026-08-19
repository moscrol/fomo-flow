"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const router = require("../vendor/外接api/core/dao_router");

test("route relay preserves priority and exposes bounded circuit recovery facts", () => {
  const now = 1_786_332_000_000;
  const candidates = router._test.buildDispatchCandidates(
    {
      provider: "first",
      model: "m1",
      channelStrategy: "priority",
      autoFallback: false,
      fallback: { provider: "second", model: "m2" },
    },
    {},
  );
  const plan = router._test.planRoute({
    candidates,
    providers: { first: { enabled: true }, second: { enabled: true } },
    circuits: new Map([
      ["first|m1", { reason: "rate_limit", until: now + 90_000 }],
    ]),
    target: { channelStrategy: "priority" },
    modelUid: "coder",
    profile: "balanced",
    request: {},
    now,
  });

  assert.deepEqual(
    plan.configuredOrder.map(({ provider, model }) => `${provider}/${model}`),
    ["first/m1", "second/m2"],
  );
  assert.deepEqual(
    plan.dispatchOrder.map(({ provider, model }) => `${provider}/${model}`),
    ["second/m2"],
  );
  assert.deepEqual(plan.excluded[0], {
    provider: "first",
    model: "m1",
    source: "primary",
    actualPriority: 1,
    estimatedCostPer1k: null,
    reason: "circuit_open",
    message: "渠道暂时熔断",
    circuitCategory: "rate_limit",
    remainingMs: 90_000,
  });
  assert.equal("until" in plan.excluded[0], false);
});

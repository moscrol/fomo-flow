"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRoutePlan } = require("../vendor/外接api/core/route_planner");

function candidate(provider, model, source = "primary") {
  return { target: { provider, model }, source };
}

function key(item) {
  return `${item.provider}/${item.model}`;
}

test("priority planning preserves configured order while advisory stays separate", () => {
  const plan = createRoutePlan({
    mode: "preflight",
    planId: "plan-fixed",
    model: "coder",
    strategy: "priority",
    profile: "cheap",
    candidates: [candidate("first", "m1"), candidate("second", "m2", "configured-fallback")],
    providers: {
      first: { enabled: true, pricing: { inPer1k: 10, outPer1k: 10 } },
      second: { enabled: true, pricing: { inPer1k: 1, outPer1k: 1 } },
    },
    circuits: new Map(),
    request: { inputTokens: 1_000, maxOutputTokens: 1_000 },
    now: 1_786_332_000_000,
  });

  assert.deepEqual(plan.configuredOrder.map(key), ["first/m1", "second/m2"]);
  assert.deepEqual(plan.dispatchOrder.map(key), ["first/m1", "second/m2"]);
  assert.deepEqual(
    plan.configuredOrder.map((item) => item.actualPriority),
    [1, 2],
  );
  assert.equal(plan.mode, "preflight");
  assert.equal(plan.profile, "cheap");
  assert.equal(plan.strategy, "priority");
  assert.equal(plan.budget.status, "not_requested");
  assert.equal(plan.advisoryOrder.length, 2);
  assert.deepEqual(
    plan.advisoryOrder.map((item) => item.advisoryRank),
    [1, 2],
  );
});

test("planning excludes unavailable candidates without mutating or leaking input", () => {
  const candidates = [
    {
      target: {
        provider: "missing",
        model: "m0",
        prompt: "PROMPT_SENTINEL",
        authorization: "AUTH_SENTINEL",
      },
      source: "primary",
    },
    {
      target: { provider: "disabled", model: "m1", path: "/SECRET_PATH_SENTINEL" },
      source: "configured-fallback",
    },
    {
      target: { provider: "open", model: "m2", sessionId: "SESSION_SENTINEL" },
      source: "auto-fallback",
    },
    candidate("ready", "m3", "auto-fallback"),
  ];
  const before = JSON.stringify(candidates);
  const plan = createRoutePlan({
    planId: "safe-plan",
    candidates,
    providers: {
      disabled: { enabled: false },
      open: { enabled: true },
      ready: { enabled: true },
    },
    circuits: new Map([["open|m2", { until: 1_786_332_060_000 }]]),
    now: 1_786_332_000_000,
  });

  assert.equal(JSON.stringify(candidates), before);
  assert.deepEqual(plan.dispatchOrder.map(key), ["ready/m3"]);
  assert.deepEqual(
    plan.excluded.map((item) => item.reason),
    ["missing_provider", "disabled", "circuit_open"],
  );
  const serialized = JSON.stringify(plan);
  for (const sentinel of [
    "PROMPT_SENTINEL",
    "AUTH_SENTINEL",
    "SECRET_PATH_SENTINEL",
    "SESSION_SENTINEL",
  ]) {
    assert.equal(serialized.includes(sentinel), false);
  }
});

test("explicit budgets only override dispatch for the declared cheapest fallback", () => {
  const base = {
    planId: "budget-plan",
    candidates: [candidate("expensive", "m1"), candidate("cheap", "m2")],
    providers: {
      expensive: { enabled: true, pricing: { inPer1k: 10, outPer1k: 10 } },
      cheap: { enabled: true, pricing: { inPer1k: 1, outPer1k: 1 } },
    },
    circuits: new Map(),
    request: { inputTokens: 1_000, maxOutputTokens: 0 },
    now: 1_786_332_000_000,
  };

  const strict = createRoutePlan({
    ...base,
    budget: { capUsd: 0.25, fallback: "strict" },
  });
  assert.equal(strict.budget.status, "strict_rejected");
  assert.deepEqual(strict.dispatchOrder, []);

  const cheapest = createRoutePlan({
    ...base,
    budget: { capUsd: 0.25, fallback: "cheapest" },
  });
  assert.equal(cheapest.budget.status, "cheapest_override");
  assert.equal(cheapest.budget.budget_override, "cheapest");
  assert.equal(cheapest.budget.overBudgetFallback, true);
  assert.deepEqual(cheapest.dispatchOrder.map(key), ["cheap/m2", "expensive/m1"]);
  assert.deepEqual(cheapest.configuredOrder.map(key), ["expensive/m1", "cheap/m2"]);

  const withinCap = createRoutePlan({
    ...base,
    budget: { capUsd: 20, fallback: "cheapest" },
  });
  assert.equal(withinCap.budget.status, "within_cap");
  assert.deepEqual(withinCap.dispatchOrder.map(key), ["expensive/m1", "cheap/m2"]);
});

test("planning reports explicit capability incompatibility and preserves legacy random input order", () => {
  const plan = createRoutePlan({
    planId: "random-plan",
    strategy: "random",
    candidates: [
      candidate("shuffled-first", "m1", "random-primary"),
      {
        target: { provider: "incompatible", model: "m2", compatible: false },
        source: "random-fallback",
      },
      candidate("shuffled-third", "m3", "random-fallback"),
    ],
    providers: {
      "shuffled-first": { enabled: true },
      incompatible: { enabled: true },
      "shuffled-third": { enabled: true },
    },
    circuits: new Map(),
    now: 1_786_332_000_000,
  });

  assert.equal(plan.strategy, "random");
  assert.deepEqual(plan.configuredOrder.map(key), [
    "shuffled-first/m1",
    "incompatible/m2",
    "shuffled-third/m3",
  ]);
  assert.deepEqual(plan.dispatchOrder.map(key), ["shuffled-first/m1", "shuffled-third/m3"]);
  assert.equal(plan.excluded[0].reason, "incompatible");
});

test("route facts redact credential-shaped text and absolute paths", () => {
  const plan = createRoutePlan({
    planId: "redaction-plan",
    model: "file:///Users/secret/model.json",
    candidates: [
      candidate("/private/provider-secret", "Authorization: AWS4-HMAC Signature=SECRET_VALUE"),
    ],
    providers: {
      "/private/provider-secret": { enabled: true },
    },
    now: 1_786_332_000_000,
  });

  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes("/Users/secret"), false);
  assert.equal(serialized.includes("/private/provider-secret"), false);
  assert.equal(serialized.includes("SECRET_VALUE"), false);
  assert.equal(serialized.includes("[路径已隐藏]"), true);
  assert.equal(serialized.includes("[凭据已隐藏]"), true);
});

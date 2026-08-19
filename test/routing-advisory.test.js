"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const profiles = require("../vendor/外接api/core/routing_profiles");
const scorer = require("../vendor/外接api/core/channel_scorer");
const router = require("../vendor/外接api/core/dao_router");

test("routing profiles are normalized, frozen, and fall back to balanced", () => {
  assert.equal(profiles.normalizeProfile("CODING"), "coding");
  assert.equal(profiles.normalizeProfile("not-a-profile"), "balanced");

  for (const profile of profiles.PROFILE_IDS) {
    const weights = profiles.weightsForProfile(profile);
    assert.equal(Object.isFrozen(weights), true);
    assert.equal(
      Number(Object.values(weights).reduce((sum, value) => sum + value, 0).toFixed(6)),
      1,
    );
  }
});

test("request budget parsing only accepts explicit safe values", () => {
  assert.deepEqual(
    profiles.parseRequestBudget({
      "X-Dao-Budget-Usd": "0.25",
      "x-dao-budget-fallback": "cheapest",
    }),
    { capUsd: 0.25, fallback: "cheapest" },
  );
  assert.equal(profiles.parseRequestBudget({}), null);
  assert.equal(profiles.parseRequestBudget({ "x-dao-budget-usd": "0" }), null);
  assert.equal(profiles.parseRequestBudget({ "x-dao-budget-usd": "1000.1" }), null);
  assert.equal(
    profiles.parseRequestBudget({
      "x-dao-budget-usd": "0.25",
      "x-dao-budget-fallback": "automatic",
    }),
    null,
  );
});

test("request cost estimation requires complete non-negative pricing and bounds", () => {
  assert.equal(
    profiles.estimateRequestCost({
      pricing: { inPer1k: 2, outPer1k: 4 },
      inputTokens: 1000,
      maxOutputTokens: 500,
    }),
    4,
  );
  assert.equal(
    profiles.estimateRequestCost({
      pricing: { inPer1k: 2 },
      inputTokens: 1000,
      maxOutputTokens: 500,
    }),
    null,
  );
});

test("explicit request budgets preserve default order and only select cheapest after all known estimates exceed the cap", () => {
  const candidates = [
    { pricing: { inPer1k: 10, outPer1k: 10 } },
    { pricing: { inPer1k: 1, outPer1k: 1 } },
  ];
  assert.equal(
    profiles.evaluateRequestBudget({ candidates, inputTokens: 1000, maxOutputTokens: 0 }).status,
    "not_requested",
  );
  assert.equal(
    profiles.evaluateRequestBudget({
      budget: { capUsd: 0.25, fallback: "strict" },
      candidates,
      inputTokens: 1000,
      maxOutputTokens: 0,
    }).status,
    "strict_rejected",
  );
  const cheapest = profiles.evaluateRequestBudget({
    budget: { capUsd: 0.25, fallback: "cheapest" },
    candidates,
    inputTokens: 1000,
    maxOutputTokens: 0,
  });
  assert.equal(cheapest.status, "cheapest_override");
  assert.equal(cheapest.preferredIndex, 1);
  assert.equal(
    profiles.evaluateRequestBudget({
      budget: { capUsd: 0.25, fallback: "strict" },
      candidates: [{ pricing: {} }],
      inputTokens: 1000,
      maxOutputTokens: 0,
    }).status,
    "unverified",
  );
});

test("channel scorer preserves its default result when no profile weights are supplied", () => {
  scorer.clearMetrics();
  const candidate = { provider: "candidate", model: "model" };
  const context = { circuits: new Map(), cacheAffinityProvider: "candidate" };
  const baseline = scorer.scoreChannel(candidate, context);
  const explicitDefault = scorer.scoreChannel(candidate, {
    ...context,
    weights: scorer.WEIGHTS,
  });
  assert.deepEqual(explicitDefault, baseline);
});

test("routing decision snapshots do not mutate priority dispatch candidates or retain request content", () => {
  router._test.clearRoutingDecisions();
  const dispatchCandidates = [
    {
      target: {
        provider: "priority-first",
        model: "m1",
        prompt: "PROMPT_SENTINEL",
        authorization: "BEARER_SENTINEL",
      },
      source: "primary",
    },
    {
      target: {
        provider: "advisory-second",
        model: "m2",
        sessionId: "SESSION_SENTINEL",
        path: "/SECRET_PATH_SENTINEL",
      },
      source: "configured-fallback",
    },
  ];
  const before = JSON.stringify(dispatchCandidates);
  router._test.recordRoutingDecision({
    candidates: dispatchCandidates,
    profile: "cheap",
    target: { channelStrategy: "priority" },
    callOpts: {
      messages: [{ content: "PROMPT_SENTINEL" }],
      headers: { authorization: "BEARER_SENTINEL" },
    },
    modelUid: "safe-model",
  });

  assert.equal(JSON.stringify(dispatchCandidates), before);
  const [decision] = router.getRoutingDecisions("cheap", 1);
  assert.equal(decision.channelStrategy, "priority");
  assert.equal(decision.mode, "advisory");
  assert.equal(decision.selected, null);
  assert.equal(decision.budget.overBudgetFallback, false);
  assert.equal(decision.candidates[0].actualPriority, 1);
  assert.equal(decision.candidates[0].provider, "priority-first");
  assert.equal(JSON.stringify(decision).includes("PROMPT_SENTINEL"), false);
  assert.equal(JSON.stringify(decision).includes("BEARER_SENTINEL"), false);
  assert.equal(JSON.stringify(decision).includes("SESSION_SENTINEL"), false);
  assert.equal(JSON.stringify(decision).includes("SECRET_PATH_SENTINEL"), false);
});

test("priority dispatch candidates keep configured order while advisory ranking stays separate", () => {
  const dispatchCandidates = router._test.buildDispatchCandidates(
    {
      provider: "priority-first",
      model: "m1",
      channelStrategy: "priority",
      autoFallback: false,
      fallback: { provider: "priority-second", model: "m2" },
    },
    {},
  );
  assert.deepEqual(
    dispatchCandidates.map(({ target }) => `${target.provider}/${target.model}`),
    ["priority-first/m1", "priority-second/m2"],
  );
  router._test.clearRoutingDecisions();
  router._test.recordRoutingDecision({
    candidates: dispatchCandidates,
    profile: "cheap",
    target: { channelStrategy: "priority" },
  });
  const [decision] = router.getRoutingDecisions("cheap", 1);
  assert.equal(decision.candidates[0].actualPriority, 1);
  assert.equal(decision.candidates[1].actualPriority, 2);
  assert.equal(decision.mode, "advisory");
});

test("router planning seam uses the configured candidate order for dispatch", () => {
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
    providers: {
      first: { enabled: true },
      second: { enabled: true },
    },
    circuits: new Map(),
    target: { channelStrategy: "priority" },
    modelUid: "coder",
    profile: "balanced",
    request: {},
    now: 1_786_332_000_000,
  });

  assert.deepEqual(
    plan.dispatchOrder.map(({ provider, model }) => `${provider}/${model}`),
    ["first/m1", "second/m2"],
  );
});

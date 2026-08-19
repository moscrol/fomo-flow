"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createRouteDecisionStore,
} = require("../vendor/外接api/core/route_decision_store");

function plan(overrides = {}) {
  return {
    planId: "plan-1",
    createdAt: "2026-08-10T03:00:00.000Z",
    expiresAt: "2026-08-10T03:05:00.000Z",
    mode: "preflight",
    model: "coder",
    profile: "balanced",
    strategy: "priority",
    configuredOrder: [
      { provider: "primary", model: "m1", source: "primary", actualPriority: 1 },
      { provider: "backup", model: "m2", source: "configured-fallback", actualPriority: 2 },
    ],
    dispatchOrder: [
      { provider: "primary", model: "m1", source: "primary", actualPriority: 1 },
      { provider: "backup", model: "m2", source: "configured-fallback", actualPriority: 2 },
    ],
    excluded: [],
    advisoryOrder: [
      { provider: "backup", model: "m2", actualPriority: 2, advisoryRank: 1 },
      { provider: "primary", model: "m1", actualPriority: 1, advisoryRank: 2 },
    ],
    budget: {
      status: "not_requested",
      capUsd: null,
      fallback: null,
      budget_override: null,
      overBudgetFallback: false,
    },
    warnings: [],
    ...overrides,
  };
}

function metadata(overrides = {}) {
  return {
    model: "coder",
    profile: "balanced",
    budgetUsd: null,
    budgetFallback: null,
    stream: true,
    usesTools: true,
    thinkingEnabled: false,
    reasoningEffort: "medium",
    ...overrides,
  };
}

test("preflight reservations match once by safe request metadata", () => {
  let now = Date.parse("2026-08-10T03:00:00.000Z");
  const store = createRouteDecisionStore({ now: () => now });
  const reserved = store.reservePreflight(plan(), metadata());

  assert.equal(reserved.planId, "plan-1");
  assert.equal(store.consumeMatchingPreflight(metadata()).planId, "plan-1");
  assert.equal(store.consumeMatchingPreflight(metadata()), null);

  store.reservePreflight(plan({ planId: "plan-expiring" }), metadata({ model: "other" }));
  now += 5 * 60 * 1000 + 1;
  assert.equal(store.consumeMatchingPreflight(metadata({ model: "other" })), null);
});

test("evidence is append-only, bounded to safe route facts, and records terminal outcome", () => {
  let now = Date.parse("2026-08-10T03:00:00.000Z");
  const store = createRouteDecisionStore({
    now: () => now,
    randomBytes: () => Buffer.alloc(12, 1),
  });
  const unsafePlan = plan({
    prompt: "PROMPT_SENTINEL",
    configuredOrder: [
      {
        provider: "primary",
        model: "m1",
        source: "primary",
        actualPriority: 1,
        authorization: "AUTH_SENTINEL",
      },
    ],
  });
  const evidence = store.beginEvidence(unsafePlan, { planId: "plan-1" });
  now += 25;
  store.appendEvidence(evidence.id, {
    kind: "attempt",
    provider: "primary",
    model: "m1",
    status: 502,
    durationMs: 25,
    errorBody: "/Users/SECRET_PATH_SENTINEL SESSION_SENTINEL",
  });
  now += 1;
  store.finishEvidence(evidence.id, {
    status: "exhausted",
    failureClass: "upstream",
    prompt: "PROMPT_SENTINEL",
  });

  const [record] = store.listEvidence(10);
  assert.equal(record.id, evidence.id);
  assert.deepEqual(
    record.events.map((event) => event.kind),
    ["plan", "attempt", "outcome"],
  );
  assert.equal(record.outcome.status, "exhausted");
  assert.equal(record.outcome.failureClass, "upstream");
  const serialized = JSON.stringify(record);
  for (const sentinel of [
    "PROMPT_SENTINEL",
    "AUTH_SENTINEL",
    "SECRET_PATH_SENTINEL",
    "SESSION_SENTINEL",
  ]) {
    assert.equal(serialized.includes(sentinel), false);
  }
});

test("decision inbox deduplicates safe rules and persists only minimal local state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dao-route-decisions-"));
  const statePath = path.join(directory, "route-decision-inbox.json");
  let now = Date.parse("2026-08-10T03:00:00.000Z");
  try {
    const store = createRouteDecisionStore({ statePath, now: () => now });
    const rejected = plan({
      planId: "plan-budget",
      budget: {
        status: "strict_rejected",
        capUsd: 0.01,
        fallback: "strict",
        overBudgetFallback: false,
      },
      dispatchOrder: [],
    });
    store.reservePreflight(rejected, metadata());
    now += 1_000;
    store.reservePreflight(rejected, metadata());

    const budgetItem = store.listInbox(20).find((item) => item.classification === "budget_rejected");
    assert.ok(budgetItem);
    assert.equal(budgetItem.count, 2);
    assert.equal(budgetItem.status, "open");
    assert.equal(store.acknowledge(budgetItem.id).status, "acknowledged");

    const persisted = fs.readFileSync(statePath, "utf8");
    assert.equal(persisted.includes("primary"), false);
    assert.equal(persisted.includes("m1"), false);
    assert.equal(persisted.includes("plan-budget"), false);
    assert.equal(persisted.includes("PROMPT_SENTINEL"), false);

    const reloaded = createRouteDecisionStore({ statePath, now: () => now });
    const restored = reloaded.listInbox(20).find((item) => item.id === budgetItem.id);
    assert.equal(restored.status, "acknowledged");
    assert.equal(reloaded.snooze(restored.id, now + 60_000).status, "snoozed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("evidence marks drift when actual route facts differ from a matched preflight", () => {
  const store = createRouteDecisionStore({
    now: () => Date.parse("2026-08-10T03:00:00.000Z"),
    randomBytes: () => Buffer.alloc(12, 2),
  });
  store.reservePreflight(plan(), metadata());
  const link = store.consumeMatchingPreflight(metadata());
  const actual = plan({
    planId: "dispatch-plan",
    mode: "dispatch",
    dispatchOrder: [
      { provider: "backup", model: "m2", source: "configured-fallback", actualPriority: 2 },
    ],
    excluded: [
      { provider: "primary", model: "m1", source: "primary", actualPriority: 1, reason: "circuit_open" },
    ],
  });
  const evidence = store.beginEvidence(actual, link);

  assert.equal(evidence.events.some((event) => event.kind === "plan_drift"), true);
  assert.equal(
    store.listInbox(20).some((item) => item.classification === "plan_drift"),
    true,
  );
});

test("evidence keeps only the newest 200 records", () => {
  let sequence = 0;
  const store = createRouteDecisionStore({
    now: () => Date.parse("2026-08-10T03:00:00.000Z") + sequence,
    randomBytes: () => {
      const value = Buffer.alloc(12);
      value.writeUInt32BE(sequence, 8);
      sequence += 1;
      return value;
    },
  });
  for (let index = 0; index < 205; index += 1) {
    store.beginEvidence(plan({ planId: `plan-${index}` }), null);
  }

  const records = store.listEvidence(200);
  assert.equal(records.length, 200);
  assert.equal(records[0].planId, "plan-204");
  assert.equal(records.at(-1).planId, "plan-5");
});

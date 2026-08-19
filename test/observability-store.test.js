"use strict";

/**
 * Public contract for core/observability_store.js
 *
 * P0: unify network (dao reverse-proxy) + lifecycle (codex rollout) into
 * confidence-tagged metrics without double-counting or inventing zeros.
 */
const assert = require("node:assert");
const {
  createObservabilityStore,
  buildObservabilityFromHudInputs,
} = require("../core/observability_store.js");

function metricShape(m) {
  assert(m && typeof m === "object");
  assert(["high", "medium", "low", "unknown"].includes(m.confidence));
  assert(typeof m.source === "string" && m.source.length > 0);
  assert(typeof m.observedAt === "number");
  return m;
}

// ── RED→GREEN: empty store never fabricates observed rates ──
{
  const store = createObservabilityStore({ now: () => 1_000 });
  const snap = store.snapshot();
  assert.strictEqual(snap.version, 1);
  assert.strictEqual(snap.global.routed.calls.value, 0);
  assert.strictEqual(snap.global.routed.calls.confidence, "high");
  assert.strictEqual(snap.global.routed.hitRate.confidence, "unknown");
  assert.strictEqual(snap.global.routed.hitRate.value, null);
  assert.strictEqual(snap.sessions.length, 0);
  assert.strictEqual(snap.health.state, "off");
}

// ── Network sample owns global routed totals ──
{
  let t = 2_000;
  const store = createObservabilityStore({ now: () => t });
  store.recordNetworkSample({
    surface: "codex",
    provider: "cockpit-codex",
    model: "gpt-5.6-sol",
    input: 1000,
    cached: 800,
    output: 50,
    ttftMs: 120,
    durationMs: 900,
    success: true,
    attemptCount: 1,
    responseToolCount: 0,
    at: 2_000,
    promptCacheKey: "private-cache-key-must-not-escape",
  });
  t = 2_100;
  store.recordNetworkSample({
    surface: "codex",
    provider: "cockpit-codex",
    model: "gpt-5.6-sol",
    input: 1000,
    cached: 0,
    output: 40,
    ttftMs: 200,
    durationMs: 1000,
    success: true,
    attemptCount: 1,
    responseToolCount: 2,
    at: 2_100,
  });

  const hitRate = metricShape(store.getMetric("global.routed.hitRate"));
  assert.strictEqual(hitRate.value, 40); // 800/2000
  assert.strictEqual(hitRate.confidence, "high");
  assert.strictEqual(hitRate.source, "network");

  const calls = metricShape(store.getMetric("global.routed.calls"));
  assert.strictEqual(calls.value, 2);

  const tools = metricShape(store.getMetric("global.routed.toolCalls"));
  assert.strictEqual(tools.value, 2);

  const snap = store.snapshot();
  const serialized = JSON.stringify(snap);
  assert(!serialized.includes("private-cache-key-must-not-escape"));
  assert.strictEqual(snap.global.routed.input.value, 2000);
  assert.strictEqual(snap.global.routed.cached.value, 800);
  assert.strictEqual(snap.health.state, "live");
}

// ── Lifecycle sessions do not double-count into global routed ──
{
  const store = createObservabilityStore({ now: () => 3_000 });
  store.recordNetworkSample({
    surface: "codex",
    provider: "cockpit-codex",
    model: "gpt-5.6-sol",
    input: 500,
    cached: 400,
    success: true,
    at: 3_000,
  });
  store.recordLifecycleSession({
    key: "codex:aaaaaaaaaaaaaaaaaaaaaaaa",
    surface: "codex",
    phase: "using-tool",
    workspace: "dao-proxy-pro",
    cache: {
      observed: true,
      calls: 3,
      input: 9000,
      cached: 8000,
      cacheWrite: 0,
      hitRate: 88.9,
      latestAt: 3_000,
    },
    telemetry: {
      reasoningTokens: 40,
      toolName: "exec_command",
      modelPath: "routed",
      loopSource: "rollout",
    },
    route: { modelUid: "gpt-5.6-sol", provider: "codex_local_access" },
    rawThreadId: "raw-thread-secret",
    privatePath: "/Users/alice/private/repo",
  });

  const globalInput = store.getMetric("global.routed.input");
  assert.strictEqual(globalInput.value, 500, "lifecycle must not add to global routed input");

  const snap = store.snapshot();
  assert.strictEqual(snap.sessions.length, 1);
  const sess = snap.sessions[0];
  assert.strictEqual(sess.key, "codex:aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.strictEqual(sess.phase, "using-tool");
  assert.strictEqual(sess.workspace, "dao-proxy-pro");
  assert.strictEqual(sess.cache.hitRate.value, 88.9);
  assert.strictEqual(sess.cache.hitRate.source, "lifecycle");
  assert.strictEqual(sess.cache.hitRate.confidence, "high");
  assert.strictEqual(sess.modelPath.value, "routed");

  const serialized = JSON.stringify(snap);
  for (const secret of ["raw-thread-secret", "/Users/alice/private", "privatePath"]) {
    assert(!serialized.includes(secret), "must not leak " + secret);
  }
}

// ── Missing lifecycle cache → unknown, not fabricated 0 ──
{
  const store = createObservabilityStore({ now: () => 4_000 });
  store.recordLifecycleSession({
    key: "codex:bbbbbbbbbbbbbbbbbbbbbbbb",
    surface: "codex",
    phase: "reasoning",
    workspace: "repo",
    cache: { observed: false },
    telemetry: {},
    route: {},
  });
  const sess = store.snapshot().sessions[0];
  assert.strictEqual(sess.cache.hitRate.value, null);
  assert.strictEqual(sess.cache.hitRate.confidence, "unknown");
}

// ── Bypassed codex (lifecycle only) stays out of routed global ──
{
  const store = createObservabilityStore({ now: () => 5_000 });
  store.recordLifecycleSession({
    key: "codex:cccccccccccccccccccccccc",
    surface: "codex",
    phase: "completed",
    workspace: "x",
    cache: { observed: true, calls: 1, input: 100, cached: 90, hitRate: 90, latestAt: 5_000 },
    telemetry: { modelPath: "bypassed" },
    route: {},
  });
  assert.strictEqual(store.getMetric("global.routed.calls").value, 0);
  assert.strictEqual(store.snapshot().sessions[0].modelPath.value, "bypassed");
}

// ── Invalid inputs are rejected without throwing ──
{
  const store = createObservabilityStore({ now: () => 6_000 });
  assert.strictEqual(store.recordNetworkSample(null), false);
  assert.strictEqual(store.recordLifecycleSession({ key: "not-a-codex-key" }), false);
  assert.strictEqual(store.getMetric("global.routed.calls").value, 0);
}

// ── Cache rate uses one protocol-independent denominator ──
{
  const store = createObservabilityStore({ now: () => 9_000 });
  store.recordNetworkSample({
    surface: "codex",
    provider: "anthropic",
    input: 100,
    cached: 900,
    output: 10,
    success: true,
    at: 9_000,
  });
  assert.strictEqual(store.getMetric("global.routed.hitRate").value, 90);
}

// ── Aggregate fallback preserves calls and reports medium confidence ──
{
  const snapshot = buildObservabilityFromHudInputs({
    now: 10_000,
    usage: {
      aggregate: {
        calls: 7,
        input: 700,
        cached: 350,
        output: 70,
        since: 9_000,
      },
    },
  });
  assert.strictEqual(snapshot.global.routed.calls.value, 7);
  assert.strictEqual(snapshot.global.routed.calls.confidence, "medium");
  assert.strictEqual(snapshot.global.routed.hitRate.value, 50);
  assert.strictEqual(snapshot.global.routed.hitRate.confidence, "medium");
}

// ── Freshness ──
{
  let now = 10_000;
  const store = createObservabilityStore({ now: () => now });
  store.recordNetworkSample({
    surface: "devin",
    provider: "glm",
    model: "glm-5.2",
    input: 10,
    cached: 0,
    success: true,
    at: 10_000,
  });
  now = 10_000 + 130_000;
  assert.strictEqual(store.snapshot().health.state, "stale");
}

// ── HUD read-path builder: request rings + no double-count from re-poll ──
{
  const { buildObservabilityFromHudInputs } = require("../core/observability_store.js");
  const usage = {
    "cockpit-codex": {
      calls: 2,
      input: 2000,
      cached: 1000,
      output: 20,
      since: 9_000,
      requests: [
        {
          at: 9_000,
          source: "codex",
          provider: "cockpit-codex",
          model: "gpt-5.6-sol",
          input: 1000,
          cached: 800,
          output: 10,
          success: true,
          responseToolCount: 0,
        },
        {
          at: 9_500,
          source: "codex",
          provider: "cockpit-codex",
          model: "gpt-5.6-sol",
          input: 1000,
          cached: 200,
          output: 10,
          success: true,
          responseToolCount: 1,
        },
      ],
    },
  };
  const a = buildObservabilityFromHudInputs({
    now: 10_000,
    usage,
    codexSummaries: [{
      key: "codex:dddddddddddddddddddddddd",
      surface: "codex",
      phase: "completed",
      workspace: "dao-proxy-pro",
      cache: { observed: true, input: 500, cached: 400, hitRate: 80, latestAt: 9_500 },
      telemetry: { modelPath: "routed" },
      route: {},
    }],
    codexRoute: { codexConfigManaged: true, routeActive: true },
  });
  const b = buildObservabilityFromHudInputs({
    now: 12_000,
    usage,
    codexSummaries: [{
      key: "codex:dddddddddddddddddddddddd",
      surface: "codex",
      phase: "completed",
      workspace: "dao-proxy-pro",
      cache: { observed: true, input: 500, cached: 400, hitRate: 80, latestAt: 9_500 },
      telemetry: { modelPath: "routed" },
      route: {},
    }],
    codexRoute: { codexConfigManaged: true, routeActive: true },
  });
  assert.strictEqual(a.global.routed.calls.value, 2);
  assert.strictEqual(a.global.routed.hitRate.value, 50);
  assert.strictEqual(a.sessions.length, 1);
  // Re-poll with same source data must not invent extra network calls.
  assert.strictEqual(b.global.routed.calls.value, 2);
  assert.strictEqual(b.global.routed.toolCalls.value, 1);
}

console.log("observability-store: PASS");

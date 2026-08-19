"use strict";

const assert = require("node:assert");
const {
  createWebHudSnapshot,
  hitRate,
} = require("../core/web_hud_projection.js");

const now = 1_000_000;

function cacheFingerprint(value) {
  const source =
    typeof value === "string" ? value : JSON.stringify(value || null);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function agent(key, overrides = {}) {
  const base = {
    key,
    version: 3,
    updatedAt: now - 500,
    observedAt: now - 250,
    identity: { kind: "native", id: `secret-${key}` },
    mode: "auto",
    activation: { state: "active", reason: "tools", activatedAt: now - 2_000 },
    activity: { requestInFlight: false, lastUpdateAt: now - 500 },
    goal: "Ship Dao Web HUD",
    phase: "testing",
    todo: { completed: 2, total: 4, current: "run focused checks" },
    verification: { latestTestStatus: "passing", blocking: false },
    ["fail" + "ures"]: {
      maxConsecutive: 0,
      sameCallStreak: 0,
      lastToolOk: true,
      hasLastError: false,
    },
    route: {
      modelUid: "swe-1-6-fast",
      provider: "ay",
      upstreamModel: "gpt-5.6-sol",
      provisional: false,
    },
    workspace: "/Users/alice/private/dao-proxy-pro",
  };
  for (const [name, value] of Object.entries(overrides)) {
    base[name] =
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...(base[name] || {}), ...value }
        : value;
  }
  return base;
}

const agentSummaries = [
  agent("cascade:secret-a"),
  agent("cascade:secret-b", {
    updatedAt: now - 300_000,
    observedAt: now - 300_000,
    activity: { lastUpdateAt: now - 300_000 },
    verification: { latestTestStatus: "failed", blocking: true },
    route: { provider: "glm", upstreamModel: "glm-5" },
  }),
  null,
  { key: "", updatedAt: now },
];

const usage = {
  ay: {
    calls: 4,
    input: 1_000,
    output: 200,
    cached: 400,
    cacheWrite: 100,
    cacheInput: 1_000,
    recent: { calls: 2, input: 500, cached: 300, hitRate: 60 },
    models: [{ model: "gpt-5.6-sol", calls: 4, input: 1_000, output: 200 }],
    requests: [
      {
        at: now - 100,
        provider: "ay",
        model: "gpt-5.6-sol",
        source: "external",
        input: 500,
        output: 80,
        cached: 300,
        cacheWrite: 50,
        hitRate: 60,
        cacheMode: "explicit",
        cacheTtl: "30m",
        usageObserved: true,
        cacheFamilyHash: "a1b2c3d4e5f6",
        breakpointCount: 2,
        stablePrefixHash: "abcdef123456",
        stablePrefixChars: 12_000,
        volatileSuffixCount: 1,
        cacheDowngrade: null,
        cacheKeyHash: cacheFingerprint("cascade:secret-a"),
        systemHash: "private-system-hash",
        prompt: "raw prompt must not escape",
        apiKey: "sk-secret",
      },
    ],
  },
  terra: {
    calls: 2,
    input: 100,
    output: 60,
    cached: 900,
    cacheWrite: 200,
    cacheInput: 1_200,
    recent: { calls: 2, input: 100, cached: 900 },
    models: [{ model: "claude-opus", calls: 2, input: 100, output: 60 }],
    requests: [
      {
        at: now - 50,
        model: "claude-opus",
        input: 100,
        output: 60,
        cached: 900,
        cacheWrite: 200,
        cacheMode: "anthropic",
        cacheTtl: "5m",
        breakpointCount: 4,
        stablePrefixHash: "fedcba987654",
        stablePrefixChars: 9_000,
        warmup: true,
      },
    ],
  },
};

const routerStatus = {
  ready: true,
  providers: ["ay", "terra", "glm"],
  provHealth: {
    ay: { alive: true, ageMs: 700 },
    terra: { alive: false, ageMs: 1_500 },
  },
  upstreamCircuits: [
    {
      provider: "terra",
      model: "claude-opus",
      status: 503,
      reason: "temporary upstream error with sk-secret",
      remainingMs: 8_000,
    },
  ],
  promptCachePolicy: {
    activeWarmups: 1,
    warmupSent: 3,
    warmupFailed: 1,
    unsupportedProviders: [{ providerHash: "safehash", reason: "unsupported" }],
  },
};

const snapshot = createWebHudSnapshot({
  now,
  runtime: { healthy: true, mode: "invert", port: 8955 },
  agentSummaries,
  routerStatus,
  usage,
  codexRoute: {
    toolSurface: "classic-forced",
    toolSurfaceHealth: {
      state: "critical",
      reason: "code_mode_without_host",
      toolSurface: "classic-forced",
      zeroToolRisk: true,
      codeModeHost: false,
      diskToolMode: "code_mode_only",
    },
  },
  componentWarnings: ["usage unavailable\nsk-secret"],
  tasks: [
    {
      jobId: "job-private",
      source: "devin",
      taskType: "review",
      workspace: "/Users/alice/private/dao-proxy-pro",
      status: "detached",
      phase: "verification",
      progress: "3/4",
      createdAt: now - 20_000,
      startedAt: now - 19_000,
      updatedAt: now - 1_000,
      lastHeartbeatAt: now - 5_000,
      leaseMs: 30_000,
      recoveryReason: "heartbeat-expired",
      attempts: [{ fallbackUsed: true }, { fallbackUsed: false }],
      result: {
        status: "unknown",
        errorCategory: "transport-lost",
        artifacts: [{ ref: "/private/report.html" }],
      },
      commandSummary: "must not be exposed",
    },
  ],
});

assert.strictEqual(snapshot.version, 1);
assert.strictEqual(snapshot.generatedAt, now);
assert.strictEqual(snapshot.runtime.healthy, true);
assert.strictEqual(snapshot.runtime.mode, "invert");
assert.strictEqual(snapshot.runtime.port, 8955);
assert.strictEqual(snapshot.runtime.connection, "live");
assert.deepStrictEqual(snapshot.runtime.componentWarnings, [
  "usage unavailable [redacted]",
]);
assert.strictEqual(snapshot.runtime.sources.codex.toolSurfaceState, "critical");
assert.strictEqual(snapshot.runtime.sources.codex.zeroToolRisk, true);
assert.strictEqual(
  snapshot.runtime.sources.codex.diskToolMode,
  "code_mode_only",
);
assert.strictEqual(
  snapshot.runtime.sources.codex.toolSurfaceReason,
  "code_mode_without_host",
);
assert.strictEqual(snapshot.totals.activeSessions, 2);
assert.strictEqual(snapshot.totals.calls, 6);
assert.strictEqual(snapshot.totals.input, 1_100);
assert.strictEqual(snapshot.totals.output, 260);
assert.strictEqual(snapshot.totals.cached, 1_300);
assert.strictEqual(snapshot.totals.cacheWrite, 300);
assert.strictEqual(snapshot.totals.hitRate, 59.1);
assert.strictEqual(snapshot.totals.openCircuits, 1);
assert.strictEqual(
  snapshot.recentRequests[0].cacheName,
  "stable-prefix:fedcba987654",
);
assert.strictEqual(
  snapshot.recentRequests[1].cacheName,
  "cache-family:a1b2c3d4e5f6",
);
assert.strictEqual(snapshot.recentRequests[1].cacheStatus, "hit");
assert.strictEqual(snapshot.recentRequests[0].cacheStatus, "unknown");
assert.strictEqual(snapshot.tasks.length, 1);
assert.strictEqual(snapshot.tasks[0].id.length, 12);
assert.notStrictEqual(snapshot.tasks[0].id, "job-private");
assert.strictEqual(snapshot.tasks[0].jobId, undefined);
assert.strictEqual(snapshot.tasks[0].status, "detached");
assert.strictEqual(snapshot.tasks[0].workspace, "dao-proxy-pro");
assert.strictEqual(snapshot.tasks[0].freshnessMs, 5_000);
assert.strictEqual(snapshot.tasks[0].fallbackCount, 1);
assert.strictEqual(snapshot.tasks[0].attempts.length, 2);
assert.strictEqual(snapshot.tasks[0].attempts[0].fallbackUsed, true);
assert.strictEqual(snapshot.tasks[0].result.errorCategory, "transport-lost");
assert.strictEqual(snapshot.taskCounts.detached, 1);
assert.doesNotMatch(
  JSON.stringify(snapshot.tasks),
  /must not be exposed|alice\/private/,
);
// Without an observability input, projection leaves the field null (service fills it).
assert.strictEqual(snapshot.observability, null);

const taskTieSnapshot = createWebHudSnapshot({
  now,
  tasks: [
    { jobId: "private-b", status: "running", updatedAt: now - 1_000 },
    { jobId: "private-a", status: "running", updatedAt: now - 1_000 },
  ],
});
assert.strictEqual(taskTieSnapshot.tasks.length, 2);
assert(taskTieSnapshot.tasks[0].id.localeCompare(taskTieSnapshot.tasks[1].id) < 0);
assert(!JSON.stringify(taskTieSnapshot.tasks).includes("private-"));

const {
  buildObservabilityFromHudInputs,
} = require("../core/observability_store.js");
const withObs = createWebHudSnapshot({
  now,
  runtime: { healthy: true, mode: "invert", port: 8955 },
  agentSummaries,
  codexSummaries: [
    {
      key: "codex:aaaaaaaaaaaaaaaaaaaaaaaa",
      surface: "codex",
      phase: "using-tool",
      workspace: "dao-proxy-pro",
      updatedAt: now - 10,
      cache: {
        observed: true,
        calls: 1,
        input: 100,
        cached: 80,
        hitRate: 80,
        latestAt: now - 10,
      },
      telemetry: { toolName: "exec_command", modelPath: "routed" },
      route: { modelUid: "gpt-5.6-sol", provider: "codex_local_access" },
    },
  ],
  codexRoute: {
    codexConfigManaged: true,
    routeActive: true,
    restartRequired: false,
  },
  routerStatus,
  usage,
  observability: buildObservabilityFromHudInputs({
    now,
    usage,
    codexSummaries: [
      {
        key: "codex:aaaaaaaaaaaaaaaaaaaaaaaa",
        surface: "codex",
        phase: "using-tool",
        workspace: "dao-proxy-pro",
        updatedAt: now - 10,
        cache: {
          observed: true,
          calls: 1,
          input: 100,
          cached: 80,
          hitRate: 80,
          latestAt: now - 10,
        },
        telemetry: { toolName: "exec_command", modelPath: "routed" },
        route: { modelUid: "gpt-5.6-sol", provider: "codex_local_access" },
      },
    ],
    codexRoute: { codexConfigManaged: true, routeActive: true },
  }),
});
assert(withObs.observability);
assert.strictEqual(
  withObs.observability.global.routed.calls.confidence,
  "high",
);
assert(withObs.observability.global.routed.calls.value >= 1);
assert.strictEqual(withObs.observability.sessions.length, 1);
assert.strictEqual(
  withObs.observability.sessions[0].workspace,
  "dao-proxy-pro",
);
assert.strictEqual(withObs.observability.sessions[0].cache.hitRate.value, 80);
assert(!JSON.stringify(withObs.observability).includes("sk-secret"));
assert.strictEqual(snapshot.sessions.length, 2);
const primarySession = snapshot.sessions.find(
  (session) => session.route.provider === "ay",
);
const flaggedSession = snapshot.sessions.find(
  (session) => session.route.provider === "glm",
);
assert.strictEqual(primarySession.active, true);
assert.strictEqual(primarySession.workspace, "dao-proxy-pro");
assert.strictEqual(primarySession.surface, "devin");
assert.strictEqual(primarySession.telemetry.ttftMs, null);
assert.strictEqual(primarySession.telemetry.durationMs, null);
assert.match(primarySession.id, /^[a-f0-9]{12}$/);
assert.deepStrictEqual(primarySession.cache, {
  observed: true,
  calls: 1,
  input: 500,
  cached: 300,
  cacheWrite: 50,
  hitRate: 60,
  latestAt: now - 100,
});
assert.deepStrictEqual(flaggedSession.cache, {
  observed: false,
  calls: 0,
  input: 0,
  cached: 0,
  cacheWrite: 0,
  hitRate: 0,
  latestAt: 0,
});
assert.strictEqual(flaggedSession.stale, false);
assert.strictEqual(flaggedSession.warning, true);
assert.strictEqual(
  snapshot.providers.find((item) => item.id === "ay").state,
  "alive",
);
assert.strictEqual(
  snapshot.providers.find((item) => item.id === "terra").state,
  "circuit-open",
);
assert.strictEqual(
  snapshot.providers.find((item) => item.id === "glm").state,
  "unknown",
);
assert.strictEqual(
  snapshot.providers.find((item) => item.id === "terra").hitRate,
  75,
);
assert.strictEqual(snapshot.recentRequests.length, 2);
assert.strictEqual(snapshot.recentRequests[0].provider, "terra");
assert.strictEqual(snapshot.recentRequests[1].stablePrefixHash, "abcdef123456");
assert.deepStrictEqual(snapshot.cachePolicy, {
  activeWarmups: 1,
  warmupSent: 3,
  warmupFailed: 1,
  unsupportedProviderCount: 1,
});
assert.strictEqual(hitRate(1_000, 400), 40);
assert.strictEqual(hitRate(100, 900), 90);
assert.strictEqual(
  hitRate(0, 100, 50),
  66.7,
  "cache writes contribute to Anthropic prompt tokens instead of producing a false 100% hit rate",
);

const cacheStatuses = createWebHudSnapshot({
  now,
  usage: {
    mock: {
      requests: [
        { at: now, model: "m", input: 10, cached: 0, usageObserved: false },
        { at: now - 1, model: "m", input: 10, cached: 0, usageObserved: true },
        { at: now - 2, model: "m", input: 10, cached: 8, usageObserved: true },
      ],
    },
  },
}).recentRequests;
assert.deepStrictEqual(
  cacheStatuses.map((request) => request.cacheStatus),
  ["unknown", "miss", "hit"],
);

const prefixContinuity = createWebHudSnapshot({
  now,
  usage: {
    cccc: {
      requests: [
        {
          at: now - 4,
          provider: "cccc",
          model: "claude-opus-5",
          cacheKeyHash: "aaaaaaaaaaaa",
          cacheFamilyHash: "bbbbbbbbbbbb",
          stableMessageCount: 2,
          stableItemHashes: ["111111111111", "222222222222"],
          usageObserved: true,
        },
        {
          at: now - 3,
          provider: "cccc",
          model: "claude-opus-5",
          cacheKeyHash: "aaaaaaaaaaaa",
          cacheFamilyHash: "bbbbbbbbbbbb",
          stableMessageCount: 3,
          stableItemHashes: ["111111111111", "222222222222", "333333333333"],
          usageObserved: true,
        },
        {
          at: now - 2,
          provider: "cccc",
          model: "claude-opus-5",
          cacheKeyHash: "aaaaaaaaaaaa",
          cacheFamilyHash: "bbbbbbbbbbbb",
          stableMessageCount: 3,
          stableItemHashes: ["111111111111", "999999999999", "333333333333"],
          usageObserved: true,
        },
        {
          at: now - 1,
          provider: "cccc",
          model: "claude-opus-5",
          cacheKeyHash: "cccccccccccc",
          cacheFamilyHash: "dddddddddddd",
          stableMessageCount: 1,
          stableItemHashes: ["444444444444"],
          usageObserved: true,
        },
      ],
    },
  },
}).recentRequests;
assert.deepStrictEqual(
  prefixContinuity.map((request) => [
    request.prefixState,
    request.prefixGeneration,
    request.prefixReason,
  ]),
  [
    ["family-changed", 3, "cache-family-changed"],
    ["rewritten", 2, "stable-prefix-rewritten"],
    ["append-only", 1, "stable-prefix-extended"],
    ["cold", 1, "first-family-sample"],
  ],
);
assert.ok(prefixContinuity.every((request) => !("cacheKeyHash" in request)));
assert.ok(prefixContinuity.every((request) => !("stableItemHashes" in request)));

const zeroTokenFailure = createWebHudSnapshot({
  now,
  usage: {
    unavailable: {
      requests: [
        {
          at: now,
          provider: "unavailable",
          model: "gpt-5.6-sol",
          input: 0,
          output: 0,
          cached: 0,
          success: false,
          errorCategory: "upstream",
        },
      ],
    },
  },
}).recentRequests;
assert.strictEqual(zeroTokenFailure.length, 1);
assert.strictEqual(zeroTokenFailure[0].input, 0);
assert.strictEqual(zeroTokenFailure[0].success, false);
assert.strictEqual(zeroTokenFailure[0].errorCategory, "upstream");

const hud = createWebHudSnapshot({
  now,
  usage: {
    mock: {
      requests: [
        {
          at: now,
          provider: "mock",
          model: "claude-opus-5",
          input: 100,
          output: 2,
          cached: 80,
          attemptCount: 2,
          requestId: "req-secret-internal",
          attempts: [
            {
              attemptId: "attempt-secret-internal",
              attemptIndex: 1,
              provider: "mock",
              model: "claude-opus-5",
              status: 502,
              outcome: "failed",
              durationMs: 12,
              errorCategory: "upstream",
              prompt: "private prompt",
            },
            {
              attemptId: "attempt-committed-internal",
              attemptIndex: 2,
              provider: "mock",
              model: "claude-opus-5",
              status: 200,
              outcome: "committed",
              durationMs: 20,
              errorCategory: "",
            },
          ],
        },
      ],
    },
  },
});
const recent = hud.recentRequests[0];
assert.strictEqual(recent.attemptCount, 2);
assert.deepStrictEqual(
  recent.attempts.map((item) => item.outcome),
  ["failed", "committed"],
);
assert.deepStrictEqual(
  recent.attempts.map((item) => item.attemptIndex),
  [1, 2],
);
assert.strictEqual(recent.attempts[0].provider, "mock");
assert.strictEqual(recent.attempts[0].model, "claude-opus-5");
assert.strictEqual(recent.attempts[0].status, 502);
assert.strictEqual(recent.attempts[0].durationMs, 12);
assert.strictEqual(recent.attempts[0].errorCategory, "upstream");
assert(!JSON.stringify(recent).includes("req-secret-internal"));
assert(!JSON.stringify(recent).includes("attempt-secret-internal"));
assert(!JSON.stringify(recent).includes("attempt-committed-internal"));
assert(!JSON.stringify(recent).includes("private prompt"));

const serialized = JSON.stringify(snapshot);
for (const privateValue of [
  "cascade:secret-a",
  "cascade:secret-b",
  "/Users/alice/private",
  "raw prompt must not escape",
  "cascade:secret-a",
  "private-system-hash",
  "sk-secret",
]) {
  assert(!serialized.includes(privateValue), `snapshot leaked ${privateValue}`);
}
assert(
  !Object.prototype.hasOwnProperty.call(
    snapshot.recentRequests[1],
    "cacheKeyHash",
  ),
);
assert(Object.isFrozen(snapshot));
assert(Object.isFrozen(snapshot.sessions));
assert(Object.isFrozen(snapshot.sessions[0]));

const reordered = createWebHudSnapshot({
  now,
  runtime: { port: 8955, mode: "invert", healthy: true },
  agentSummaries: [...agentSummaries].reverse(),
  routerStatus: {
    ...routerStatus,
    providers: [...routerStatus.providers].reverse(),
    provHealth: {
      terra: routerStatus.provHealth.terra,
      ay: routerStatus.provHealth.ay,
    },
  },
  usage: { terra: usage.terra, ay: usage.ay },
  codexRoute: {
    toolSurface: "classic-forced",
    toolSurfaceHealth: {
      state: "critical",
      reason: "code_mode_without_host",
      toolSurface: "classic-forced",
      zeroToolRisk: true,
      codeModeHost: false,
      diskToolMode: "code_mode_only",
    },
  },
  componentWarnings: ["usage unavailable\nsk-secret"],
  tasks: [
    {
      jobId: "job-private",
      source: "devin",
      taskType: "review",
      workspace: "/Users/alice/private/dao-proxy-pro",
      status: "detached",
      phase: "verification",
      progress: "3/4",
      createdAt: now - 20_000,
      startedAt: now - 19_000,
      updatedAt: now - 1_000,
      lastHeartbeatAt: now - 5_000,
      leaseMs: 30_000,
      recoveryReason: "heartbeat-expired",
      attempts: [{ fallbackUsed: true }, { fallbackUsed: false }],
      result: {
        status: "unknown",
        errorCategory: "transport-lost",
        artifacts: [{ ref: "/private/report.html" }],
      },
    },
  ],
});
assert.deepStrictEqual(reordered, snapshot, "projection must be deterministic");

const isolatedCache = createWebHudSnapshot({
  now,
  agentSummaries: [
    agent("session-cache-a", {
      goal: "Session cache A",
      route: { provider: "ay", upstreamModel: "gpt-5.6-sol" },
    }),
    agent("session-cache-b", {
      goal: "Session cache B",
      route: { provider: "ay", upstreamModel: "gpt-5.6-sol" },
    }),
  ],
  usage: {
    ay: {
      input: 1_000,
      cached: 500,
      requests: [
        {
          at: now - 20,
          provider: "ay",
          model: "gpt-5.6-sol",
          input: 500,
          cached: 100,
          cacheKeyHash: cacheFingerprint("session-cache-a"),
        },
        {
          at: now - 10,
          provider: "ay",
          model: "gpt-5.6-sol",
          input: 500,
          cached: 400,
          sessionHash: cacheFingerprint("session-cache-b"),
        },
      ],
    },
  },
});
const cacheA = isolatedCache.sessions.find(
  (session) => session.goal === "Session cache A",
).cache;
const cacheB = isolatedCache.sessions.find(
  (session) => session.goal === "Session cache B",
).cache;
assert.strictEqual(cacheA.hitRate, 20);
assert.strictEqual(cacheB.hitRate, 80);
assert.notStrictEqual(cacheA.hitRate, cacheB.hitRate);
assert.strictEqual(
  isolatedCache.recentRequests.find(
    (request) =>
      request.cacheName === `cache-key:${cacheFingerprint("session-cache-a")}`,
  ).cacheName,
  `cache-key:${cacheFingerprint("session-cache-a")}`,
);
assert.strictEqual(
  isolatedCache.recentRequests.find((request) => request.cached === 400)
    .cacheName,
  "",
);
assert(!JSON.stringify(isolatedCache).includes('"cacheKeyHash"'));
assert(!JSON.stringify(isolatedCache).includes('"sessionHash"'));

const agentKeyCache = createWebHudSnapshot({
  now,
  agentSummaries: [
    agent("agent-key-session", {
      goal: "Agent key cache session",
      route: { provider: "ay", upstreamModel: "gpt-5.6-terra" },
    }),
  ],
  usage: {
    ay: {
      requests: [
        {
          at: now - 5,
          provider: "ay",
          model: "gpt-5.6-terra",
          input: 1_000,
          cached: 700,
          agentSessionHash: cacheFingerprint("agent-key-session"),
          sessionHash: cacheFingerprint("prompt-cache-key"),
          cacheKeyHash: cacheFingerprint("prompt-cache-key"),
        },
      ],
    },
  },
});
assert.strictEqual(
  agentKeyCache.sessions[0].cache.hitRate,
  70,
  "session cache must match the agent-status key before prompt-cache fallbacks",
);

const terraRouteAyHits = createWebHudSnapshot({
  now,
  agentSummaries: [
    agent("terra-devin-session", {
      goal: "Terra route with ay fallback hits",
      route: { provider: "terra", upstreamModel: "gpt-5.6-terra" },
    }),
  ],
  usage: {
    ay: {
      requests: [
        {
          at: now - 5,
          provider: "ay",
          model: "gpt-5.6-terra",
          input: 1_000,
          cached: 700,
          agentSessionHash: cacheFingerprint("terra-devin-session"),
          sessionHash: cacheFingerprint("prompt-cache-key"),
          cacheKeyHash: cacheFingerprint("prompt-cache-key"),
        },
      ],
    },
    terra: { requests: [] },
  },
});
assert.strictEqual(
  terraRouteAyHits.sessions[0].cache.observed,
  true,
  "Devin session cache must keep ay/gpt-5.6-terra hits when the route label is terra",
);
assert.strictEqual(terraRouteAyHits.sessions[0].cache.hitRate, 70);
assert.strictEqual(terraRouteAyHits.sessions[0].cache.calls, 1);
assert.strictEqual(terraRouteAyHits.sessions[0].cache.cached, 700);

const terraRouteModelAligned = createWebHudSnapshot({
  now,
  agentSummaries: [
    agent("terra-model-aligned", {
      goal: "Terra route aligned by upstream model",
      route: { provider: "terra", upstreamModel: "gpt-5.6-terra" },
    }),
  ],
  usage: {
    ay: {
      requests: [
        {
          at: now - 5,
          provider: "ay",
          model: "gpt-5.6-terra",
          input: 2_000,
          cached: 500,
          sessionHash: cacheFingerprint("terra-model-aligned"),
        },
      ],
    },
  },
});
assert.strictEqual(
  terraRouteModelAligned.sessions[0].cache.hitRate,
  25,
  "same upstream model may join a terra-labeled session when only the prompt-cache hash is present",
);

const terraRouteMustNotBleed = createWebHudSnapshot({
  now,
  agentSummaries: [
    agent("terra-no-bleed", {
      goal: "Terra route must not absorb glm hits",
      route: { provider: "terra", upstreamModel: "gpt-5.6-terra" },
    }),
  ],
  usage: {
    glm: {
      requests: [
        {
          at: now - 5,
          provider: "glm",
          model: "glm-5.3",
          input: 1_000,
          cached: 900,
          sessionHash: cacheFingerprint("terra-no-bleed"),
        },
      ],
    },
  },
});
assert.deepStrictEqual(
  terraRouteMustNotBleed.sessions[0].cache,
  {
    observed: false,
    calls: 0,
    input: 0,
    cached: 0,
    cacheWrite: 0,
    hitRate: 0,
    latestAt: 0,
  },
  "a terra-labeled session must not absorb another model's cache hits",
);

const retention = createWebHudSnapshot({
  now,
  agentSummaries: [
    agent("retention-boundary", {
      goal: "Boundary session",
      updatedAt: now - 900_000,
      observedAt: now,
      activation: { state: "dormant" },
      activity: {
        requestInFlight: false,
        lastRequestAt: now - 900_000,
        lastUpdateAt: now - 900_000,
      },
    }),
    agent("retention-expired", {
      goal: "Expired session",
      updatedAt: now - 900_001,
      observedAt: now,
      activation: { state: "dormant" },
      activity: {
        requestInFlight: false,
        lastRequestAt: now - 900_001,
        lastUpdateAt: now - 900_001,
      },
    }),
    agent("retention-active", {
      goal: "Pinned active session",
      mode: "on",
      updatedAt: now - 3_600_000,
      observedAt: now,
      activation: { state: "active" },
      activity: {
        requestInFlight: false,
        lastRequestAt: now - 3_600_000,
        lastUpdateAt: now - 3_600_000,
      },
    }),
  ],
});
const boundarySession = retention.sessions.find(
  (session) => session.goal === "Boundary session",
);
assert(boundarySession);
assert.strictEqual(boundarySession.lifecycle, "recently-ended");
assert(
  !retention.sessions.some((session) => session.goal === "Expired session"),
);
assert(
  !retention.sessions.some(
    (session) => session.goal === "Pinned active session",
  ),
  "an expired active flag must not keep a stopped session on the live desk",
);

const staleInFlightSnapshot = createWebHudSnapshot({
  now,
  agentSummaries: [
    agent("hydrated-in-flight", {
      mode: "on",
      updatedAt: now - 3_600_000,
      observedAt: now,
      activation: { state: "active" },
      activity: {
        requestInFlight: true,
        lastRequestAt: now - 3_600_000,
        lastUpdateAt: now - 3_600_000,
      },
    }),
  ],
});
assert.strictEqual(
  staleInFlightSnapshot.sessions.length,
  0,
  "an expired requestInFlight flag must retire with the same hard upper bound",
);

const lifecycleSnapshot = createWebHudSnapshot({
  now,
  agentSummaries: [
    agent("still-active", {
      goal: "still-active",
      mode: "on",
      updatedAt: now - 5 * 60_000,
      activation: { state: "active" },
      activity: { lastUpdateAt: now - 5 * 60_000 },
    }),
    agent("retire-after-five", {
      goal: "retire-after-five",
      mode: "on",
      updatedAt: now - 5 * 60_000 - 1,
      activation: { state: "active" },
      activity: { requestInFlight: true, lastUpdateAt: now - 5 * 60_000 - 1 },
    }),
    agent("needs-attention", {
      goal: "needs-attention",
      mode: "on",
      updatedAt: now - 12 * 60_000,
      activation: { state: "active" },
      activity: { requestInFlight: true, lastUpdateAt: now - 12 * 60_000 },
    }),
    agent("explicitly-stopped", {
      goal: "explicitly-stopped",
      mode: "on",
      updatedAt: now - 30_000,
      activation: { state: "stopped" },
      activity: { requestInFlight: true, lastUpdateAt: now - 30_000 },
      failures: { hasLastError: true, lastToolOk: false },
    }),
  ],
});
assert.strictEqual(
  lifecycleSnapshot.sessions.find((session) => session.goal === "still-active")
    .lifecycle,
  "active",
);
const retiredAfterFive = lifecycleSnapshot.sessions.find(
  (session) => session.goal === "retire-after-five",
);
assert(retiredAfterFive);
assert.strictEqual(retiredAfterFive.active, false);
assert.strictEqual(retiredAfterFive.requestInFlight, false);
assert.strictEqual(retiredAfterFive.lifecycle, "stale");
assert.strictEqual(
  lifecycleSnapshot.sessions.find(
    (session) => session.goal === "needs-attention",
  ).lifecycle,
  "stale",
);
const stoppedSession = lifecycleSnapshot.sessions.find(
  (session) => session.goal === "explicitly-stopped",
);
assert.strictEqual(stoppedSession.lifecycle, "stopped");
assert.strictEqual(stoppedSession.active, false);
assert.strictEqual(stoppedSession.requestInFlight, false);

const boundedAgents = Array.from({ length: 80 }, (_, index) =>
  agent(`session-${index}`, {
    goal: "g".repeat(500),
    todo: { current: "t".repeat(500) },
  }),
);
const boundedUsage = {};
for (let providerIndex = 0; providerIndex < 40; providerIndex += 1) {
  boundedUsage[`provider-${providerIndex}`] = {
    calls: 1,
    input: 1,
    requests: Array.from({ length: 3 }, (_, requestIndex) => ({
      at: now - requestIndex,
      model: "m".repeat(200),
      input: 1,
    })),
  };
}
const bounded = createWebHudSnapshot({
  now,
  agentSummaries: boundedAgents,
  routerStatus: { providers: Object.keys(boundedUsage) },
  usage: boundedUsage,
});
assert.strictEqual(bounded.sessions.length, 64);
assert.strictEqual(bounded.providers.length, 32);
assert.strictEqual(bounded.recentRequests.length, 40);
assert(bounded.sessions[0].goal.length <= 120);
assert(bounded.sessions[0].todo.current.length <= 100);
assert(bounded.recentRequests[0].model.length <= 100);

const malformed = createWebHudSnapshot({
  now: Symbol("bad"),
  runtime: null,
  agentSummaries: "bad",
  routerStatus: { providers: [null, {}, "safe"] },
  usage: { safe: { input: -4, output: Infinity, requests: "bad" } },
  componentWarnings: [null, {}, "ok"],
});
assert.strictEqual(malformed.version, 1);
assert.strictEqual(malformed.sessions.length, 0);
assert.strictEqual(malformed.providers.length, 1);
assert.strictEqual(malformed.totals.input, 0);

const warningNoise = createWebHudSnapshot({
  now,
  routerStatus: {
    providers: ["unused-down", "used-down"],
    provHealth: {
      "unused-down": { alive: false, ageMs: 10 },
      "used-down": { alive: false, ageMs: 10 },
    },
  },
  usage: {
    "unused-down": { calls: 0, requests: [] },
    "used-down": { calls: 1, requests: [] },
  },
});
assert.strictEqual(
  warningNoise.totals.warnings,
  1,
  "configured-but-unused degraded channels stay visible without inflating alerts",
);

const promptBoilerplate = createWebHudSnapshot({
  now,
  agentSummaries: [
    agent("system-goal", {
      goal: "<system_info> automatically generated private environment context",
    }),
    agent("memory-goal", {
      goal: "No MEMORIES were retrieved. Continue your work without acknowledging this message.",
    }),
    agent("retrieved-memory-goal", {
      goal: "These memories were automatically retrieved from previous conversations and may or may not be relevant.",
    }),
  ],
});
assert.deepStrictEqual(
  promptBoilerplate.sessions.map((session) => session.goal),
  ["", "", ""],
  "system prompt boilerplate must not cross the Web HUD boundary",
);

const codexSummary = {
  key: "codex:private-key",
  surface: "codex",
  version: 4,
  updatedAt: now - 10,
  observedAt: now - 10,
  activation: { state: "active" },
  activity: { requestInFlight: true, lastUpdateAt: now - 10 },
  goal: "Codex task",
  phase: "using-tool",
  workspace: "/Users/alice/private/codex-repo",
  route: {
    modelUid: "gpt-5.6-sol",
    provider: "codex_local_access",
    upstreamModel: "gpt-5.6-sol",
  },
  cache: {
    observed: true,
    calls: 1,
    input: 1000,
    cached: 800,
    cacheWrite: 0,
    hitRate: 80,
    latestAt: now - 10,
  },
  telemetry: {
    reasoningTokens: 40,
    contextWindow: 353400,
    compactions: 1,
    toolName: "exec",
    ttftMs: 120,
    durationMs: 900,
  },
};
const mixed = createWebHudSnapshot({
  now,
  agentSummaries: [agent("devin-private")],
  codexSummaries: [codexSummary],
  codexHealth: {
    state: "live",
    lastEventAt: now - 10,
    ageMs: 10,
    unknownEvents: 0,
    parseErrors: 0,
  },
  codexRoute: {
    routeActive: true,
    codexConfigManaged: true,
    provider: "cockpit-codex",
    model: "gpt-5.6-sol",
    restartRequired: false,
  },
  usage: {
    "cockpit-codex": {
      calls: 6,
      input: 600,
      output: 120,
      cached: 300,
      requests: [
        {
          at: now - 60,
          provider: "cockpit-codex",
          model: "gpt-5.6-sol",
          source: "codex",
          input: 100,
          cached: 80,
          success: true,
          firstSignalKind: "text",
          ttftMs: 100,
          durationMs: 600,
          daoDispatchMs: 2,
          upstreamHeaderMs: 40,
          upstreamSemanticMs: 90,
          retryOverheadMs: 8,
        },
        {
          at: now - 50,
          provider: "cockpit-codex",
          model: "gpt-5.6-sol",
          source: "codex",
          input: 100,
          cached: 80,
          success: true,
          firstSignalKind: "tool",
          ttftMs: 200,
          durationMs: 700,
          daoDispatchMs: 3,
          upstreamHeaderMs: 60,
          upstreamSemanticMs: 180,
          retryOverheadMs: 17,
        },
        {
          at: now - 40,
          provider: "cockpit-codex",
          model: "gpt-5.6-sol",
          source: "codex",
          input: 100,
          cached: 80,
          success: true,
          firstSignalKind: "text",
          ttftMs: 400,
          durationMs: 800,
          daoDispatchMs: 4,
          upstreamHeaderMs: 90,
          upstreamSemanticMs: 360,
          retryOverheadMs: 36,
        },
        {
          at: now - 30,
          provider: "cockpit-codex",
          model: "gpt-5.6-sol",
          source: "codex",
          input: 100,
          cached: 0,
          success: true,
          firstSignalKind: "text",
          ttftMs: 800,
          durationMs: 1200,
          daoDispatchMs: 5,
          upstreamHeaderMs: 120,
          upstreamSemanticMs: 760,
          retryOverheadMs: 35,
        },
        {
          at: now - 20,
          provider: "cockpit-codex",
          model: "gpt-5.6-sol",
          source: "codex",
          input: 100,
          cached: 0,
          success: true,
          firstSignalKind: "text",
          ttftMs: 1200,
          durationMs: 1600,
          daoDispatchMs: 6,
          upstreamHeaderMs: 140,
          upstreamSemanticMs: 1100,
          retryOverheadMs: 94,
        },
        {
          at: now - 10,
          provider: "cockpit-codex",
          model: "gpt-5.6-sol",
          source: "codex",
          input: 100,
          cached: 0,
          success: true,
          firstSignalKind: "text",
          ttftMs: 2000,
          durationMs: 2400,
          daoDispatchMs: 7,
          upstreamHeaderMs: 160,
          upstreamSemanticMs: 1800,
          retryOverheadMs: 193,
          cacheKeyHash: "must-not-cross",
        },
      ],
    },
  },
});
assert.deepStrictEqual(mixed.sessions.map((item) => item.surface).sort(), [
  "codex",
  "devin",
]);
const codexSession = mixed.sessions.find((item) => item.surface === "codex");
assert.strictEqual(codexSession.cache.hitRate, 80);
assert.strictEqual(codexSession.route.provider, "cockpit-codex");
assert.strictEqual(codexSession.telemetry.modelPath, "routed");
assert.strictEqual(codexSession.telemetry.reasoningTokens, 40);
assert.strictEqual(
  mixed.totals.input,
  600,
  "rollout usage must not be added to routed usage",
);
assert.strictEqual(mixed.runtime.sources.codex.state, "live");
const latencyProvider = mixed.providers.find(
  (item) => item.id === "cockpit-codex",
);
assert.strictEqual(latencyProvider.latency.overall.count, 6);
assert.strictEqual(latencyProvider.latency.overall.p50TtftMs, 400);
assert.strictEqual(latencyProvider.latency.overall.p95TtftMs, 2000);
assert.strictEqual(latencyProvider.latency.cache.hit.p95TtftMs, 400);
assert.strictEqual(latencyProvider.latency.cache.miss.p95TtftMs, 2000);
assert.strictEqual(mixed.runtime.latency.overall.count, 6);
assert.strictEqual(mixed.recentRequests[0].daoDispatchMs, 7);
assert.strictEqual(mixed.recentRequests[0].upstreamHeaderMs, 160);
assert.strictEqual(mixed.recentRequests[0].upstreamSemanticMs, 1800);
assert.strictEqual(mixed.recentRequests[0].retryOverheadMs, 193);
assert.strictEqual(mixed.recentRequests[0].firstSignalKind, "text");
assert(!JSON.stringify(mixed).includes("must-not-cross"));
assert(!JSON.stringify(mixed).includes("codex:private-key"));
assert(!JSON.stringify(mixed).includes("/Users/alice/private"));

const spoofed = createWebHudSnapshot({
  now,
  agentSummaries: [agent("spoofed", { surface: "codex" })],
  codexSummaries: [],
});
assert.strictEqual(spoofed.sessions[0].surface, "devin");

const codexRetention = createWebHudSnapshot({
  now,
  codexSummaries: [
    {
      ...codexSummary,
      key: "codex:boundary",
      updatedAt: now - 900_000,
      observedAt: now - 900_000,
      activation: { state: "dormant" },
      activity: { requestInFlight: false, lastUpdateAt: now - 900_000 },
    },
    {
      ...codexSummary,
      key: "codex:expired",
      updatedAt: now - 900_001,
      observedAt: now - 900_001,
      activation: { state: "dormant" },
      activity: { requestInFlight: false, lastUpdateAt: now - 900_001 },
    },
  ],
});
assert.strictEqual(
  codexRetention.sessions.filter((session) => session.surface === "codex")
    .length,
  1,
);

console.log("web hud projection: PASS");

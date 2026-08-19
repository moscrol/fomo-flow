"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { classifyCachePrefixContinuity } = require("./cache_prefix_continuity.js");
const { summarizeSamples } = require("./ttft_metrics.js");

const SESSION_LIMIT = 64;
const PROVIDER_LIMIT = 32;
const REQUEST_LIMIT = 40;
const ACTIVE_TTL_MS = 5 * 60_000;
const STALE_TTL_MS = 5 * 60_000;
const RECENT_SESSION_TTL_MS = 15 * 60_000;
const TERMINAL_SESSION_STATES = new Set([
  "stopped",
  "closed",
  "completed",
  "cancelled",
]);

function finiteNonnegative(value, fallback = 0) {
  if (value == null || typeof value === "boolean") return fallback;
  try {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch {
    return fallback;
  }
}

function integer(value, fallback = 0) {
  return Math.floor(finiteNonnegative(value, fallback));
}

function optionalNonnegative(value) {
  if (value == null || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function redact(value) {
  return String(value == null ? "" : value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/gi, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function text(value, limit) {
  return typeof value === "string" ? redact(value).slice(0, limit) : "";
}

function basename(value) {
  const normalized = text(value, 2_000).replace(/\\/g, "/");
  return normalized ? text(path.basename(normalized), 120) : "";
}

function goalText(value) {
  const goal = text(value, 120);
  if (!goal) return "";
  if (goal.startsWith("<")) return "";
  if (/^No MEMORIES were retrieved\b/i.test(goal)) return "";
  if (/^These memories were automatically retrieved\b/i.test(goal)) return "";
  if (/^The following memories (?:were|have been) automatically retrieved\b/i.test(goal))
    return "";
  if (/^The following information is automatically generated\b/i.test(goal))
    return "";
  if (/^You have \d+ weighted tokens left\b/i.test(goal)) return "";
  return goal;
}

function sessionId(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex")
    .slice(0, 12);
}

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

function cacheInputDenominator(input, cached, cacheWrite) {
  const inTokens = finiteNonnegative(input);
  const cachedTokens = finiteNonnegative(cached);
  const cacheWriteTokens = finiteNonnegative(cacheWrite);
  return cachedTokens > inTokens
    ? inTokens + cachedTokens + cacheWriteTokens
    : inTokens;
}

function hitRate(input, cached, cacheWrite, cacheInput) {
  const cachedTokens = finiteNonnegative(cached);
  const denominator =
    finiteNonnegative(cacheInput) || cacheInputDenominator(input, cached, cacheWrite);
  return denominator
    ? Math.round((cachedTokens / denominator) * 1_000) / 10
    : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function warningFor(summary) {
  const verification = object(summary.verification);
  const failures = object(summary.failures);
  return (
    verification.latestTestStatus === "failed" ||
    verification.blocking === true ||
    finiteNonnegative(failures.sameCallStreak) >= 2 ||
    finiteNonnegative(failures.maxConsecutive) >= 3 ||
    (failures.hasLastError === true && failures.lastToolOk === false)
  );
}

function latestActivityAt(summary) {
  const activity = object(summary.activity);
  return Math.max(
    finiteNonnegative(activity.lastRequestAt),
    finiteNonnegative(activity.lastUpdateAt),
    finiteNonnegative(summary.updatedAt),
  );
}

function projectSession(summary, now, forcedSurface = "devin", context = {}) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary))
    return null;
  if (typeof summary.key !== "string" || !summary.key.trim()) return null;

  const activation = object(summary.activation);
  const activity = object(summary.activity);
  const todo = object(summary.todo);
  const verification = object(summary.verification);
  const failures = object(summary.failures);
  const route = object(summary.route);
  const nativeCache = object(summary.cache);
  const telemetry = object(summary.telemetry);
  const codexRoute = object(context.codexRoute);
  const surface = forcedSurface === "codex" ? "codex" : "devin";
  const isCodex = surface === "codex";
  const identity = object(summary.identity);
  const updatedAt = finiteNonnegative(summary.updatedAt);
  const observedAt = finiteNonnegative(summary.observedAt, updatedAt);
  const lastActivityAt = latestActivityAt(summary);
  const freshnessMs = Math.max(0, now - lastActivityAt);
  const stale = freshnessMs > STALE_TTL_MS;
  const activationState = text(activation.state, 40) || "unknown";
  const terminal = TERMINAL_SESSION_STATES.has(activationState);
  const requestedActive =
    !terminal &&
    activation.state === "active" &&
    (summary.mode === "on" ||
      activity.requestInFlight === true ||
      freshnessMs <= ACTIVE_TTL_MS);
  const active = requestedActive && !stale;
  const stalePinned =
    !terminal &&
    stale &&
    (activation.state === "active" || activity.requestInFlight === true);

  return {
    _cacheKeyHash: cacheFingerprint(summary.key),
    _nativeCache: isCodex
      ? {
          observed: nativeCache.observed === true,
          calls: integer(nativeCache.calls),
          input: finiteNonnegative(nativeCache.input),
          cached: finiteNonnegative(nativeCache.cached),
          cacheWrite: finiteNonnegative(nativeCache.cacheWrite),
          hitRate: finiteNonnegative(nativeCache.hitRate),
          latestAt: finiteNonnegative(nativeCache.latestAt),
        }
      : null,
    id: sessionId(summary.key),
    surface,
    identityKind: identity.kind === "native" ? "native" : "derived",
    mode: text(summary.mode, 40) || "auto",
    activation: activationState,
    active,
    lifecycle: terminal
      ? activationState
      : stalePinned
        ? "stale"
        : active
          ? "active"
          : "recently-ended",
    stale,
    warning: warningFor(summary),
    updatedAt,
    observedAt,
    latestActivityAt: lastActivityAt,
    freshnessMs,
    requestInFlight: !terminal && !stale && activity.requestInFlight === true,
    goal: goalText(summary.goal),
    phase: text(summary.phase, 60) || "unknown",
    todo: {
      completed: integer(todo.completed),
      total: integer(todo.total),
      current: text(todo.current, 100),
    },
    verification: {
      status: text(verification.latestTestStatus, 40) || "unknown",
      blocking: verification.blocking === true,
    },
    failures: {
      maxConsecutive: integer(failures.maxConsecutive),
      sameCallStreak: integer(failures.sameCallStreak),
      lastToolOk:
        failures.lastToolOk === true
          ? true
          : failures.lastToolOk === false
            ? false
            : null,
      hasLastError: failures.hasLastError === true,
    },
    route: {
      modelUid: isCodex
        ? text(codexRoute.model, 100) || text(route.modelUid, 100)
        : text(route.modelUid, 100),
      provider: isCodex
        ? text(codexRoute.provider, 100) || text(route.provider, 100)
        : route.provisional === true
          ? ""
          : text(route.provider, 100),
      upstreamModel: isCodex
        ? text(codexRoute.model, 100) || text(route.upstreamModel, 100)
        : text(route.upstreamModel, 100),
      provisional: isCodex
        ? codexRoute.routeActive !== true
        : route.provisional === true,
    },
    workspace: basename(summary.workspace),
    telemetry: {
      reasoningTokens: finiteNonnegative(telemetry.reasoningTokens),
      contextWindow: finiteNonnegative(telemetry.contextWindow),
      compactions: integer(telemetry.compactions),
      toolName: text(telemetry.toolName, 80),
      ttftMs: optionalNonnegative(telemetry.ttftMs),
      durationMs: optionalNonnegative(telemetry.durationMs),
      reasoningEffort: text(telemetry.reasoningEffort, 20),
      loopSource: isCodex ? "rollout" : "agent-status",
      modelPath: isCodex ? text(context.modelPath, 40) || "unknown" : "routed",
    },
  };
}

function emptySessionCache() {
  return {
    observed: false,
    calls: 0,
    input: 0,
    cached: 0,
    cacheWrite: 0,
    hitRate: 0,
    latestAt: 0,
  };
}

function hashEquals(value, fingerprint) {
  return String(value || "").toLowerCase() === fingerprint;
}

function sampleBelongsToSession(sample, fingerprint, route, providerName) {
  const routeProvider =
    route.provisional === true ? "" : text(route.provider, 100);
  const routeModel = text(route.upstreamModel, 100);
  const provider = text(sample.provider, 100) || text(providerName, 100);
  const model = text(sample.model, 100);
  const agentHash = text(sample.agentSessionHash, 64);
  if (agentHash) return hashEquals(agentHash, fingerprint);
  const keyHash =
    text(sample.sessionHash, 64) || text(sample.cacheKeyHash, 64);
  if (!keyHash || !hashEquals(keyHash, fingerprint)) return false;
  if (!routeProvider || provider === routeProvider) return true;
  return !!(routeModel && model && model === routeModel);
}

function projectSessionCache(session, usage) {
  const fingerprint = session && session._cacheKeyHash;
  if (!fingerprint) return emptySessionCache();
  const route = object(session.route);
  const matches = [];

  for (const [providerName, providerValue] of Object.entries(usage)) {
    const samples = Array.isArray(object(providerValue).requests)
      ? object(providerValue).requests
      : [];
    for (const sample of samples) {
      if (!sample || typeof sample !== "object" || Array.isArray(sample))
        continue;
      if (!sampleBelongsToSession(sample, fingerprint, route, providerName)) {
        continue;
      }
      matches.push(sample);
    }
  }

  if (!matches.length) return emptySessionCache();
  const input = matches.reduce(
    (sum, sample) => sum + finiteNonnegative(sample.input),
    0,
  );
  const cached = matches.reduce(
    (sum, sample) => sum + finiteNonnegative(sample.cached),
    0,
  );
  const cacheWrite = matches.reduce(
    (sum, sample) => sum + finiteNonnegative(sample.cacheWrite),
    0,
  );
  const latestAt = matches.reduce(
    (latest, sample) => Math.max(latest, finiteNonnegative(sample.at)),
    0,
  );
  return {
    observed: true,
    calls: matches.length,
    input,
    cached,
    cacheWrite,
    hitRate: hitRate(input, cached, cacheWrite),
    latestAt,
  };
}

function publicSession(session, usage) {
  const cache =
    session.surface === "codex" && session._nativeCache
      ? session._nativeCache
      : projectSessionCache(session, usage);
  const { _cacheKeyHash, _nativeCache, ...safeSession } = session;
  return { ...safeSession, cache };
}

function sessionSort(left, right) {
  return (
    Number(right.active) - Number(left.active) ||
    Number(right.warning) - Number(left.warning) ||
    right.updatedAt - left.updatedAt ||
    left.id.localeCompare(right.id)
  );
}

function providerNames(routerStatus, usage) {
  const names = new Set();
  const configured = Array.isArray(routerStatus.providers)
    ? routerStatus.providers
    : [];
  for (const value of configured) {
    const name = text(value, 100);
    if (name) names.add(name);
  }
  for (const value of Object.keys(object(routerStatus.provHealth))) {
    const name = text(value, 100);
    if (name) names.add(name);
  }
  for (const value of Object.keys(usage)) {
    const name = text(value, 100);
    if (name) names.add(name);
  }
  const circuits = Array.isArray(routerStatus.upstreamCircuits)
    ? routerStatus.upstreamCircuits
    : [];
  for (const circuit of circuits) {
    const name = text(circuit && circuit.provider, 100);
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b)).slice(0, PROVIDER_LIMIT);
}

function reasonCategory(value) {
  const raw = text(value, 200).toLowerCase();
  if (!raw) return "upstream";
  if (/401|auth|credential|api key/.test(raw)) return "authentication";
  if (/403|permission|forbidden/.test(raw)) return "permission";
  if (/balance|quota|credit|billing/.test(raw)) return "quota";
  if (/404|model.+(?:missing|not found)|not found.+model/.test(raw))
    return "model-missing";
  if (/429|rate.?limit|too many/.test(raw)) return "rate-limit";
  if (/timeout|timed out/.test(raw)) return "timeout";
  if (/network|socket|connect|dns/.test(raw)) return "network";
  return "upstream";
}

function projectProvider(name, routerStatus, usage) {
  const health = object(object(routerStatus.provHealth)[name]);
  const providerUsage = object(usage[name]);
  const circuits = (
    Array.isArray(routerStatus.upstreamCircuits)
      ? routerStatus.upstreamCircuits
      : []
  ).filter((circuit) => text(circuit && circuit.provider, 100) === name);
  const recent = object(providerUsage.recent);
  const models = Array.isArray(providerUsage.models)
    ? providerUsage.models
    : [];
  const leadModel = models
    .filter((item) => item && typeof item === "object")
    .sort(
      (a, b) =>
        finiteNonnegative(
          b.total,
          finiteNonnegative(b.input) + finiteNonnegative(b.output),
        ) -
        finiteNonnegative(
          a.total,
          finiteNonnegative(a.input) + finiteNonnegative(a.output),
        ),
    )[0];
  let state = "unknown";
  if (circuits.length) state = "circuit-open";
  else if (health.alive === true) state = "alive";
  else if (health.alive === false) state = "degraded";
  const input = finiteNonnegative(providerUsage.input);
  const cached = finiteNonnegative(providerUsage.cached);
  const recentInput = finiteNonnegative(recent.input);
  const recentCached = finiteNonnegative(recent.cached);
  const recentCacheWrite = finiteNonnegative(recent.cacheWrite);
  const firstCircuit = circuits[0] || {};
  const latencySamples = (
    Array.isArray(providerUsage.requests) ? providerUsage.requests : []
  )
    .map((sample) => projectLatencySample(sample, name))
    .filter(Boolean);

  return {
    id: name,
    state,
    alive: health.alive === true ? true : health.alive === false ? false : null,
    ageMs: finiteNonnegative(health.ageMs),
    model: text(leadModel && leadModel.model, 100),
    calls: integer(providerUsage.calls),
    input,
    output: finiteNonnegative(providerUsage.output),
    cached,
    cacheWrite: finiteNonnegative(providerUsage.cacheWrite),
    hitRate: hitRate(input, cached, providerUsage.cacheWrite, providerUsage.cacheInput),
    recentHitRate: hitRate(recentInput, recentCached, recentCacheWrite, recent.cacheInput),
    recentCalls: integer(recent.calls),
    latency: summarizeSamples(latencySamples),
    openCircuits: circuits.length,
    circuit: circuits.length
      ? {
          status: integer(firstCircuit.status),
          category: reasonCategory(firstCircuit.reason),
          model: text(firstCircuit.model, 100),
          remainingMs: finiteNonnegative(firstCircuit.remainingMs),
        }
      : null,
  };
}

function providerSort(left, right) {
  const priority = { "circuit-open": 0, degraded: 1, alive: 2, unknown: 3 };
  return (
    priority[left.state] - priority[right.state] ||
    right.calls - left.calls ||
    left.id.localeCompare(right.id)
  );
}

function safeHash(value) {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  return /^[a-f0-9]{6,64}$/.test(raw) ? raw.slice(0, 16) : "";
}

function cacheName(sample) {
  const cacheFamilyHash = safeHash(sample && sample.cacheFamilyHash);
  if (cacheFamilyHash) return `cache-family:${cacheFamilyHash}`;
  const cacheKeyHash = safeHash(sample && sample.cacheKeyHash);
  if (cacheKeyHash) return `cache-key:${cacheKeyHash}`;
  const stablePrefixHash = safeHash(sample && sample.stablePrefixHash);
  return stablePrefixHash ? `stable-prefix:${stablePrefixHash}` : "";
}

function cacheStatus(sample) {
  if (!sample || sample.usageObserved !== true) return "unknown";
  return finiteNonnegative(sample.cached) > 0 ? "hit" : "miss";
}

function projectLatencySample(sample, fallbackProvider) {
  if (!sample || typeof sample !== "object" || Array.isArray(sample))
    return null;
  const firstSignalKind =
    sample.firstSignalKind === "text" || sample.firstSignalKind === "tool"
      ? sample.firstSignalKind
      : "none";
  return {
    at: optionalNonnegative(sample.at),
    provider:
      text(sample.provider, 100) || text(fallbackProvider, 100) || "unknown",
    model: text(sample.model, 100) || "?",
    source: text(sample.source, 40) || "external",
    input: optionalNonnegative(sample.input),
    cached: optionalNonnegative(sample.cached),
    ttftMs: optionalNonnegative(sample.ttftMs),
    durationMs: optionalNonnegative(sample.durationMs),
    firstSignalKind,
    success: sample.success === true,
  };
}

function projectAttempt(attempt) {
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt))
    return null;
  const outcome = ["committed", "failed", "discarded"].includes(attempt.outcome)
    ? attempt.outcome
    : "discarded";
  const status = Number(attempt.status);
  return {
    attemptIndex: Math.max(1, integer(attempt.attemptIndex, 1)),
    provider: text(attempt.provider, 100),
    model: text(attempt.model, 100) || "?",
    startedAt: optionalNonnegative(attempt.startedAt),
    endedAt: optionalNonnegative(attempt.endedAt),
    durationMs: optionalNonnegative(attempt.durationMs),
    status:
      Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    outcome,
    errorCategory: text(attempt.errorCategory, 40),
    retryReason: text(attempt.retryReason, 80),
    usageObserved: attempt.usageObserved === true,
    input: optionalNonnegative(attempt.input),
    output: optionalNonnegative(attempt.output),
    cached: optionalNonnegative(attempt.cached),
    cacheWrite: optionalNonnegative(attempt.cacheWrite),
  };
}

function allLatencySamples(usage) {
  const samples = [];
  for (const providerName of Object.keys(usage).sort((a, b) =>
    a.localeCompare(b),
  )) {
    const requests = Array.isArray(object(usage[providerName]).requests)
      ? object(usage[providerName]).requests
      : [];
    for (const request of requests) {
      const sample = projectLatencySample(request, providerName);
      if (sample) samples.push(sample);
    }
  }
  return samples;
}

function projectRequests(usage) {
  const requests = [];
  const names = Object.keys(usage).sort((a, b) => a.localeCompare(b));
  for (const providerName of names) {
    const providerUsage = object(usage[providerName]);
    const samples = Array.isArray(providerUsage.requests)
      ? providerUsage.requests
      : [];
    const continuity = classifyCachePrefixContinuity(samples);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (!sample || typeof sample !== "object" || Array.isArray(sample))
        continue;
      const provider = text(sample.provider, 100) || text(providerName, 100);
      const model = text(sample.model, 100) || "?";
      const at = finiteNonnegative(sample.at);
      const attempts = (Array.isArray(sample.attempts) ? sample.attempts : [])
        .slice(-8)
        .map(projectAttempt)
        .filter(Boolean);
      const idSeed = `${provider}\u0000${model}\u0000${at}\u0000${index}`;
      requests.push({
        id: sessionId(idSeed),
        at,
        provider,
        model,
        source: text(sample.source, 40) || "external",
        input: finiteNonnegative(sample.input),
        output: finiteNonnegative(sample.output),
        cached: finiteNonnegative(sample.cached),
        cacheWrite: finiteNonnegative(sample.cacheWrite),
        hitRate: hitRate(sample.input, sample.cached, sample.cacheWrite),
        cacheMode: text(sample.cacheMode, 40) || "off",
        cacheTtl: text(sample.cacheTtl, 20),
        cacheName: cacheName(sample),
        cacheFamilyHash: safeHash(sample.cacheFamilyHash),
        cacheStatus: cacheStatus(sample),
        breakpointCount: integer(sample.breakpointCount),
        stablePrefixChars: integer(sample.stablePrefixChars),
        stablePrefixHash: safeHash(sample.stablePrefixHash),
        prefixState: continuity[index].prefixState,
        prefixGeneration: continuity[index].prefixGeneration,
        prefixReason: continuity[index].prefixReason,
        volatileSuffixCount: integer(sample.volatileSuffixCount),
        cacheDowngrade: text(sample.cacheDowngrade, 80),
        warmup: sample.warmup === true,
        ttftMs: optionalNonnegative(sample.ttftMs),
        ttftObserved: sample.ttftObserved === true,
        daoDispatchMs: optionalNonnegative(sample.daoDispatchMs),
        upstreamHeaderMs: optionalNonnegative(sample.upstreamHeaderMs),
        upstreamSemanticMs: optionalNonnegative(sample.upstreamSemanticMs),
        retryOverheadMs: optionalNonnegative(sample.retryOverheadMs),
        durationMs: optionalNonnegative(sample.durationMs),
        attemptCount: Math.max(
          1,
          integer(sample.attemptCount, attempts.length || 1),
        ),
        committedAttempt:
          Math.max(0, integer(sample.committedAttempt, 0)) || null,
        attempts,
        responseToolCount: integer(sample.responseToolCount),
        textBytes: integer(sample.textBytes),
        reasoningEffort: text(sample.reasoningEffort, 20),
        firstSignalKind:
          sample.firstSignalKind === "text" || sample.firstSignalKind === "tool"
            ? sample.firstSignalKind
            : "none",
        success: sample.success === true,
        usageObserved: sample.usageObserved === true,
        errorCategory: text(sample.errorCategory, 40),
      });
    }
  }
  return requests
    .sort(
      (a, b) =>
        b.at - a.at ||
        a.provider.localeCompare(b.provider) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, REQUEST_LIMIT);
}

function sumUsage(usage) {
  const totals = {
    calls: 0,
    input: 0,
    output: 0,
    cached: 0,
    cacheWrite: 0,
    cacheInput: 0,
  };
  for (const providerUsage of Object.values(usage)) {
    const item = object(providerUsage);
    totals.calls += integer(item.calls);
    totals.input += finiteNonnegative(item.input);
    totals.output += finiteNonnegative(item.output);
    totals.cached += finiteNonnegative(item.cached);
    totals.cacheWrite += finiteNonnegative(item.cacheWrite);
    totals.cacheInput +=
      finiteNonnegative(item.cacheInput) ||
      cacheInputDenominator(item.input, item.cached, item.cacheWrite);
  }
  return totals;
}

function projectConfidenceMetric(value, fallbackSource) {
  const item = object(value);
  const confidence = text(item.confidence, 20);
  const allowed = new Set(["high", "medium", "low", "unknown"]);
  const conf = allowed.has(confidence) ? confidence : "unknown";
  let metricValue = item.value;
  if (conf === "unknown" && (metricValue === 0 || metricValue === undefined)) {
    metricValue = item.value == null ? null : metricValue;
  }
  if (
    metricValue != null &&
    typeof metricValue !== "number" &&
    typeof metricValue !== "string"
  ) {
    metricValue = null;
  }
  if (typeof metricValue === "string") metricValue = text(metricValue, 80);
  if (typeof metricValue === "number" && !Number.isFinite(metricValue))
    metricValue = null;
  return {
    value: conf === "unknown" && metricValue == null ? null : metricValue,
    confidence: conf,
    source: text(item.source, 40) || text(fallbackSource, 40) || "unknown",
    observedAt: finiteNonnegative(item.observedAt),
  };
}

function projectTaskAttempt(attempt) {
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt))
    return null;
  return {
    provider: text(attempt.provider, 100),
    model: text(attempt.model, 100),
    fallbackUsed: attempt.fallbackUsed === true,
    fallbackReason: text(attempt.fallbackReason, 80),
    toolCallCount: Math.max(0, integer(attempt.toolCallCount, 0)),
    durationMs: optionalNonnegative(attempt.durationMs),
    errorCategory: text(attempt.errorCategory, 40),
    at: optionalNonnegative(attempt.at),
  };
}

function projectTasks(raw, now) {
  const tasks = (Array.isArray(raw) ? raw : [])
    .filter((task) => task && typeof task === "object" && !Array.isArray(task))
    .slice(0, 64)
    .map((task) => {
      const result = object(task.result);
      const attempts = (Array.isArray(task.attempts) ? task.attempts : [])
        .slice(-8)
        .map(projectTaskAttempt)
        .filter(Boolean);
      const fallbackCount = attempts.filter(
        (attempt) => attempt.fallbackUsed === true,
      ).length;
      const lastHeartbeatAt = finiteNonnegative(task.lastHeartbeatAt);
      const updatedAt = finiteNonnegative(task.updatedAt);
      const exitCode =
        result.exitCode == null ? null : integer(result.exitCode);
      return {
        id: sessionId(task.jobId),
        source: text(task.source, 40) || "unknown",
        taskType: text(task.taskType, 80),
        workspace: basename(task.targetWorkspace || task.workspace),
        status: text(task.status, 32) || "unknown",
        phase: text(task.phase, 80),
        progress: text(task.progress, 160),
        createdAt: finiteNonnegative(task.createdAt),
        startedAt: finiteNonnegative(task.startedAt),
        updatedAt,
        lastHeartbeatAt,
        freshnessMs: lastHeartbeatAt
          ? Math.max(0, now - lastHeartbeatAt)
          : Math.max(0, now - updatedAt),
        leaseMs: finiteNonnegative(task.leaseMs),
        recoveryReason: text(task.recoveryReason, 100),
        attemptCount: attempts.length,
        attempts,
        fallbackCount,
        result: {
          status: text(result.status, 32),
          exitCode,
          errorCategory: text(result.errorCategory, 80),
          finishedAt: finiteNonnegative(result.finishedAt),
          artifactCount: Array.isArray(result.artifacts)
            ? result.artifacts.length
            : 0,
        },
      };
    })
    .filter((task) => task.id)
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
    );
  const counts = Object.create(null);
  for (const task of tasks)
    counts[task.status] = (counts[task.status] || 0) + 1;
  return { tasks, counts };
}

function projectObservability(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = object(raw);
  const globalRouted = object(object(source.global).routed);
  const health = object(source.health);
  const sessions = (Array.isArray(source.sessions) ? source.sessions : [])
    .slice(0, SESSION_LIMIT)
    .map((session) => {
      const item = object(session);
      const cache = object(item.cache);
      return {
        key: text(item.key, 64),
        surface: text(item.surface, 20) || "codex",
        phase: text(item.phase, 40),
        workspace: text(item.workspace, 120),
        updatedAt: finiteNonnegative(item.updatedAt),
        cache: {
          hitRate: projectConfidenceMetric(cache.hitRate, "lifecycle"),
          input: projectConfidenceMetric(cache.input, "lifecycle"),
          cached: projectConfidenceMetric(cache.cached, "lifecycle"),
        },
        toolName: text(item.toolName, 80),
        modelPath: projectConfidenceMetric(item.modelPath, "lifecycle"),
      };
    })
    .filter((session) => session.key);
  const recentNetwork = (
    Array.isArray(source.recentNetwork) ? source.recentNetwork : []
  )
    .slice(-REQUEST_LIMIT)
    .map((sample) => {
      const item = object(sample);
      return {
        at: finiteNonnegative(item.at),
        surface: text(item.surface, 20),
        provider: text(item.provider, 80),
        model: text(item.model, 80),
        input: integer(item.input),
        cached: integer(item.cached),
        output: integer(item.output),
        ttftMs: optionalNonnegative(item.ttftMs),
        durationMs: optionalNonnegative(item.durationMs),
        success: item.success === true,
        responseToolCount: integer(item.responseToolCount),
      };
    });

  return {
    version: integer(source.version) || 1,
    health: {
      state: text(health.state, 40) || "off",
      lastEventAt: finiteNonnegative(health.lastEventAt),
      ageMs: finiteNonnegative(health.ageMs),
    },
    global: {
      routed: {
        calls: projectConfidenceMetric(globalRouted.calls, "network"),
        input: projectConfidenceMetric(globalRouted.input, "network"),
        cached: projectConfidenceMetric(globalRouted.cached, "network"),
        output: projectConfidenceMetric(globalRouted.output, "network"),
        toolCalls: projectConfidenceMetric(globalRouted.toolCalls, "network"),
        hitRate: projectConfidenceMetric(globalRouted.hitRate, "network"),
      },
    },
    sessions,
    recentNetwork,
  };
}

function createWebHudSnapshot(input = {}) {
  const source = object(input);
  const now = finiteNonnegative(source.now, Date.now());
  const runtimeInput = object(source.runtime);
  const routerStatus = object(source.routerStatus);
  const usage = object(source.usage);
  const codexHealth = object(source.codexHealth);
  const codexRoute = object(source.codexRoute);
  const agentSummaries = Array.isArray(source.agentSummaries)
    ? source.agentSummaries
    : [];
  const codexSummaries = Array.isArray(source.codexSummaries)
    ? source.codexSummaries
    : [];
  const codexModelPath =
    codexRoute.codexConfigManaged === true && codexRoute.routeActive === true
      ? codexRoute.restartRequired === true
        ? "restart-required"
        : "routed"
      : codexSummaries.length
        ? "bypassed"
        : "unknown";
  const warnings = (
    Array.isArray(source.componentWarnings) ? source.componentWarnings : []
  )
    .map((value) => text(value, 120))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 8);
  const sessionInputs = [
    ...agentSummaries.map((summary) => ({ summary, surface: "devin" })),
    ...codexSummaries.map((summary) => ({ summary, surface: "codex" })),
  ];
  const sessions = sessionInputs
    .map(({ summary, surface }) =>
      projectSession(summary, now, surface, {
        codexRoute,
        modelPath: codexModelPath,
      }),
    )
    .filter(Boolean)
    .filter(
      (session) =>
        session.active || session.freshnessMs <= RECENT_SESSION_TTL_MS,
    )
    .sort(sessionSort)
    .slice(0, SESSION_LIMIT)
    .map((session) => publicSession(session, usage));
  const providers = providerNames(routerStatus, usage)
    .map((name) => projectProvider(name, routerStatus, usage))
    .sort(providerSort);
  const requests = projectRequests(usage);
  const runtimeLatency = summarizeSamples(allLatencySamples(usage));
  const usageTotals = sumUsage(usage);
  const policy = object(routerStatus.promptCachePolicy);
  const activeSessions = sessions.filter((session) => session.active).length;
  const warningSessions = sessions.filter((session) => session.warning).length;
  const unhealthyProviders = providers.filter(
    (provider) =>
      provider.state === "circuit-open" ||
      (provider.state === "degraded" && provider.calls > 0),
  ).length;
  const openCircuits = providers.reduce(
    (sum, provider) => sum + provider.openCircuits,
    0,
  );
  const healthy = runtimeInput.healthy === true;

  const observability = projectObservability(source.observability);
  const taskProjection = projectTasks(source.tasks, now);

  return deepFreeze({
    version: 1,
    generatedAt: now,
    runtime: {
      healthy,
      mode: text(runtimeInput.mode, 40) || "unknown",
      port: integer(runtimeInput.port),
      connection: healthy ? "live" : "partial",
      componentWarnings: warnings,
      sources: {
        codex: {
          state: text(codexHealth.state, 40) || "off",
          lastEventAt: finiteNonnegative(codexHealth.lastEventAt),
          ageMs: finiteNonnegative(codexHealth.ageMs),
          unknownEvents: integer(codexHealth.unknownEvents),
          parseErrors: integer(codexHealth.parseErrors),
          modelPath: codexModelPath,
          // Tool-surface health: critical when code_mode_* without host
          toolSurface:
            text(object(codexRoute.toolSurfaceHealth).toolSurface, 40) ||
            text(codexRoute.toolSurface, 40) ||
            "classic-forced",
          toolSurfaceState:
            text(object(codexRoute.toolSurfaceHealth).state, 20) || "unknown",
          toolSurfaceReason: text(
            object(codexRoute.toolSurfaceHealth).reason,
            80,
          ),
          zeroToolRisk:
            object(codexRoute.toolSurfaceHealth).zeroToolRisk === true,
          codeModeHost:
            object(codexRoute.toolSurfaceHealth).codeModeHost === true,
          diskToolMode: text(
            object(codexRoute.toolSurfaceHealth).diskToolMode,
            40,
          ),
        },
      },
      latency: runtimeLatency,
    },
    totals: {
      activeSessions,
      warnings: warningSessions + unhealthyProviders + warnings.length,
      calls: usageTotals.calls,
      input: usageTotals.input,
      output: usageTotals.output,
      cached: usageTotals.cached,
      cacheWrite: usageTotals.cacheWrite,
      hitRate: hitRate(
        usageTotals.input,
        usageTotals.cached,
        usageTotals.cacheWrite,
        usageTotals.cacheInput,
      ),
      openCircuits,
    },
    sessions,
    providers,
    recentRequests: requests,
    tasks: taskProjection.tasks,
    taskCounts: taskProjection.counts,
    // Confidence-tagged dual-source view (network + lifecycle). Optional for
    // older clients; never replaces totals (ownership stays with usage).
    observability,
    cachePolicy: {
      activeWarmups: integer(policy.activeWarmups),
      warmupSent: integer(policy.warmupSent),
      warmupFailed: integer(policy.warmupFailed),
      unsupportedProviderCount: Array.isArray(policy.unsupportedProviders)
        ? policy.unsupportedProviders.length
        : 0,
    },
  });
}

module.exports = {
  createWebHudSnapshot,
  hitRate,
  projectObservability,
};

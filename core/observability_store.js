"use strict";

/**
 * Observability store — confidence-tagged metrics over dual sources.
 *
 * Ownership (from codex-dao-cockpit observability design):
 * - Network samples own global routed usage, TTFT, retries, tool-call counts.
 * - Lifecycle (rollout) owns per-session phase/cache/tool name; never adds to
 *   global routed totals (avoids double-count when Codex is also routed).
 * - Missing observations are confidence "unknown" with value null — never a
 *   fabricated 0% hit rate.
 * - Public snapshots never include raw thread ids, cache keys, or full paths.
 */

const ALLOWED_SURFACES = new Set(["codex", "devin"]);
const CONFIDENCE = new Set(["high", "medium", "low", "unknown"]);
const STALE_MS = 120_000;
const MAX_SESSIONS = 64;
const MAX_NETWORK_SAMPLES = 200;

function finiteNonneg(value) {
  if (value == null || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function shortStr(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function metric(value, confidence, source, observedAt) {
  const conf = CONFIDENCE.has(confidence) ? confidence : "unknown";
  return {
    value: conf === "unknown" ? (value == null ? null : value) : value,
    confidence: conf,
    source: shortStr(source, 40) || "unknown",
    observedAt: finiteNonneg(observedAt) || 0,
  };
}

function unknownMetric(source, observedAt) {
  return metric(null, "unknown", source, observedAt);
}

// OpenAI-style usage includes cached tokens in input; Anthropic-style usage
// reports cache reads separately. This keeps both forms bounded to 0..100%.
function cacheHitRate(input, cached) {
  const inputTokens = finiteNonneg(input) || 0;
  const cachedTokens = finiteNonneg(cached) || 0;
  const denominator = cachedTokens > inputTokens
    ? inputTokens + cachedTokens
    : inputTokens;
  return denominator
    ? Math.round((cachedTokens / denominator) * 1000) / 10
    : 0;
}

function isCodexSessionKey(key) {
  return /^codex:[a-f0-9]{24}$/.test(String(key || ""));
}

function createObservabilityStore(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const network = {
    calls: 0,
    input: 0,
    cached: 0,
    output: 0,
    toolCalls: 0,
    successes: 0,
    confidence: "high",
    samples: [],
    lastAt: 0,
  };
  const sessions = new Map();
  const diagnostics = {
    lastEventAt: 0,
    rejectedNetwork: 0,
    rejectedLifecycle: 0,
  };

  function touch(at) {
    const ts = finiteNonneg(at) ?? now();
    diagnostics.lastEventAt = Math.max(diagnostics.lastEventAt, ts);
    return ts;
  }

  function recordNetworkSample(sample) {
    if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
      diagnostics.rejectedNetwork += 1;
      return false;
    }
    const surface = shortStr(sample.surface, 20) || "devin";
    if (!ALLOWED_SURFACES.has(surface)) {
      diagnostics.rejectedNetwork += 1;
      return false;
    }
    const at = touch(sample.at);
    const input = finiteNonneg(sample.input) || 0;
    const cached = finiteNonneg(sample.cached) || 0;
    const output = finiteNonneg(sample.output) || 0;
    const toolCalls = finiteNonneg(sample.responseToolCount) || 0;
    const calls = Math.max(1, Math.floor(finiteNonneg(sample.calls) || 1));
    const confidence = sample.confidence === "medium" ? "medium" : "high";
    const success = sample.success === true;

    network.confidence = confidence === "medium" ? "medium" : network.confidence;
    network.calls += calls;
    network.input += input;
    network.cached += cached;
    network.output += output;
    network.toolCalls += toolCalls;
    if (success) network.successes += 1;
    network.lastAt = at;

    // Keep a bounded, sanitized sample ring (no cache keys / content).
    network.samples.push({
      at,
      surface,
      provider: shortStr(sample.provider, 80),
      model: shortStr(sample.model, 80),
      input,
      cached,
      output,
      ttftMs: finiteNonneg(sample.ttftMs),
      durationMs: finiteNonneg(sample.durationMs),
      success,
      attemptCount: finiteNonneg(sample.attemptCount) || 1,
      responseToolCount: toolCalls,
    });
    if (network.samples.length > MAX_NETWORK_SAMPLES) {
      network.samples.splice(0, network.samples.length - MAX_NETWORK_SAMPLES);
    }
    return true;
  }

  function recordLifecycleSession(summary) {
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
      diagnostics.rejectedLifecycle += 1;
      return false;
    }
    const key = shortStr(summary.key, 64);
    if (!isCodexSessionKey(key) && summary.surface !== "devin") {
      // Codex keys must be hashed codex:<24 hex>; allowlisted shape only.
      if (!/^codex:[a-f0-9]{24}$/.test(key) && !/^devin:[a-f0-9]{8,64}$/.test(key)) {
        diagnostics.rejectedLifecycle += 1;
        return false;
      }
    }
    if (!isCodexSessionKey(key) && !/^devin:/.test(key)) {
      diagnostics.rejectedLifecycle += 1;
      return false;
    }

    const at = touch(summary.updatedAt || summary.observedAt || summary.cache?.latestAt);
    const cache = summary.cache && typeof summary.cache === "object" ? summary.cache : {};
    const telemetry =
      summary.telemetry && typeof summary.telemetry === "object" ? summary.telemetry : {};
    const route = summary.route && typeof summary.route === "object" ? summary.route : {};
    const observed = cache.observed === true;
    const input = finiteNonneg(cache.input);
    const cached = finiteNonneg(cache.cached);
    const hitRate =
      observed && input != null && input > 0 && cached != null
        ? cacheHitRate(input, cached)
        : finiteNonneg(cache.hitRate);

    const entry = {
      key,
      surface: shortStr(summary.surface, 20) || "codex",
      phase: shortStr(summary.phase, 40) || "idle",
      workspace: shortStr(summary.workspace, 120),
      updatedAt: at,
      cache: {
        observed,
        hitRate: observed
          ? metric(hitRate, "high", "lifecycle", at)
          : unknownMetric("lifecycle", at),
        input: observed ? metric(input ?? 0, "high", "lifecycle", at) : unknownMetric("lifecycle", at),
        cached: observed
          ? metric(cached ?? 0, "high", "lifecycle", at)
          : unknownMetric("lifecycle", at),
      },
      toolName: shortStr(telemetry.toolName, 80),
      reasoningTokens: metric(
        finiteNonneg(telemetry.reasoningTokens) ?? 0,
        finiteNonneg(telemetry.reasoningTokens) != null ? "medium" : "unknown",
        "lifecycle",
        at,
      ),
      modelPath: metric(
        shortStr(telemetry.modelPath, 40) || "unknown",
        telemetry.modelPath ? "medium" : "unknown",
        "lifecycle",
        at,
      ),
      route: {
        modelUid: shortStr(route.modelUid, 100),
        provider: shortStr(route.provider, 100),
      },
    };

    sessions.set(key, entry);
    // Bound session map by oldest updatedAt
    if (sessions.size > MAX_SESSIONS) {
      const ordered = [...sessions.entries()].sort(
        (a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0),
      );
      while (sessions.size > MAX_SESSIONS) {
        sessions.delete(ordered.shift()[0]);
      }
    }
    return true;
  }

  function routedHitRate() {
    if (network.calls === 0 || network.input <= 0) {
      return unknownMetric("network", network.lastAt || 0);
    }
    const rate = cacheHitRate(network.input, network.cached);
    return metric(rate, network.confidence, "network", network.lastAt);
  }

  function getMetric(path) {
    const at = diagnostics.lastEventAt || 0;
    switch (String(path || "")) {
      case "global.routed.calls":
        return metric(network.calls, network.calls ? network.confidence : "high", "network", at);
      case "global.routed.input":
        return metric(network.input, network.calls ? network.confidence : "unknown", "network", at);
      case "global.routed.cached":
        return metric(network.cached, network.calls ? network.confidence : "unknown", "network", at);
      case "global.routed.output":
        return metric(network.output, network.calls ? network.confidence : "unknown", "network", at);
      case "global.routed.toolCalls":
        return metric(network.toolCalls, network.calls ? network.confidence : "unknown", "network", at);
      case "global.routed.hitRate":
        return routedHitRate();
      default:
        return unknownMetric("unknown", at);
    }
  }

  function health() {
    const last = diagnostics.lastEventAt;
    if (!last) {
      return { state: "off", lastEventAt: 0, ageMs: 0 };
    }
    const ageMs = Math.max(0, now() - last);
    return {
      state: ageMs > STALE_MS ? "stale" : "live",
      lastEventAt: last,
      ageMs,
      rejectedNetwork: diagnostics.rejectedNetwork,
      rejectedLifecycle: diagnostics.rejectedLifecycle,
    };
  }

  function snapshot() {
    const at = diagnostics.lastEventAt || 0;
    const sessionList = [...sessions.values()]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map((s) => JSON.parse(JSON.stringify(s)));

    return {
      version: 1,
      generatedAt: now(),
      health: health(),
      global: {
        routed: {
          calls: getMetric("global.routed.calls"),
          input: getMetric("global.routed.input"),
          cached: getMetric("global.routed.cached"),
          output: getMetric("global.routed.output"),
          toolCalls: getMetric("global.routed.toolCalls"),
          hitRate: getMetric("global.routed.hitRate"),
        },
      },
      sessions: sessionList,
      // Recent sanitized network samples for HUD request rail
      recentNetwork: network.samples.slice(-20).map((s) => ({ ...s })),
      _meta: {
        // Explicit non-secrets only
        networkSampleCount: network.samples.length,
        sessionCount: sessions.size,
        observedAt: at,
      },
    };
  }

  return {
    recordNetworkSample,
    recordLifecycleSession,
    getMetric,
    snapshot,
    health,
  };
}

/**
 * Build a one-shot observability snapshot from existing HUD readers.
 * Recomputes from absolute request rings + lifecycle summaries so repeated
 * HUD polls never double-count cumulative router totals.
 */
function buildObservabilityFromHudInputs(input = {}) {
  const nowValue =
    typeof input.now === "function"
      ? Number(input.now()) || Date.now()
      : Number(input.now) || Date.now();
  const store = createObservabilityStore({ now: () => nowValue });
  const usage = input.usage && typeof input.usage === "object" ? input.usage : {};
  const codexRoute =
    input.codexRoute && typeof input.codexRoute === "object" ? input.codexRoute : {};
  const modelPath =
    codexRoute.codexConfigManaged === true && codexRoute.routeActive === true
      ? codexRoute.restartRequired === true
        ? "restart-required"
        : "routed"
      : Array.isArray(input.codexSummaries) && input.codexSummaries.length
        ? "bypassed"
        : "unknown";

  for (const [providerName, providerUsage] of Object.entries(usage)) {
    if (!providerUsage || typeof providerUsage !== "object") continue;
    const requests = Array.isArray(providerUsage.requests) ? providerUsage.requests : [];
    const surfaceHint =
      String(providerName).includes("cockpit") || String(providerName).includes("codex")
        ? "codex"
        : "devin";

    if (requests.length) {
      for (const request of requests) {
        if (!request || typeof request !== "object") continue;
        const source = String(request.source || "").toLowerCase();
        const surface =
          source === "codex" || source.includes("codex") ? "codex" : surfaceHint;
        store.recordNetworkSample({
          surface,
          provider: request.provider || providerName,
          model: request.model,
          input: request.input,
          cached: request.cached,
          output: request.output,
          ttftMs: request.ttftMs,
          durationMs: request.durationMs,
          success: request.success !== false,
          attemptCount: request.attemptCount,
          responseToolCount: request.responseToolCount,
          at: request.at || nowValue,
        });
      }
      continue;
    }

    // No request ring: fall back to provider aggregates (medium confidence path
    // is still better than empty when only totals exist).
    // Use provider.since (or a fixed epoch) — never poll-time — so HUD SSE
    // coalescing does not treat every cadence tick as a content change.
    if ((Number(providerUsage.calls) || 0) > 0) {
      const sinceAt = Number(providerUsage.since);
      store.recordNetworkSample({
        surface: surfaceHint,
        provider: providerName,
        model: "",
        calls: providerUsage.calls,
        confidence: "medium",
        input: providerUsage.input,
        cached: providerUsage.cached,
        output: providerUsage.output,
        success: true,
        attemptCount: 1,
        responseToolCount: 0,
        at: Number.isFinite(sinceAt) && sinceAt > 0 ? sinceAt : 1,
      });
    }
  }

  for (const summary of Array.isArray(input.codexSummaries) ? input.codexSummaries : []) {
    if (!summary || typeof summary !== "object") continue;
    const telemetry =
      summary.telemetry && typeof summary.telemetry === "object" ? summary.telemetry : {};
    store.recordLifecycleSession({
      key: summary.key,
      surface: summary.surface || "codex",
      phase: summary.phase,
      workspace: summary.workspace,
      updatedAt: summary.updatedAt || summary.observedAt,
      observedAt: summary.observedAt,
      cache: summary.cache,
      telemetry: {
        ...telemetry,
        modelPath: telemetry.modelPath || modelPath,
      },
      route: summary.route,
    });
  }

  return store.snapshot();
}

module.exports = {
  createObservabilityStore,
  buildObservabilityFromHudInputs,
  metric,
  unknownMetric,
};

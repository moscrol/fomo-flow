"use strict";

const crypto = require("crypto");

const channelScorer = require("./channel_scorer");
const routingProfiles = require("./routing_profiles");

const PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_CANDIDATES = 20;
const MAX_CIRCUIT_REMAINING_MS = 24 * 60 * 60 * 1000;
const CIRCUIT_CATEGORIES = new Set([
  "authentication",
  "balance",
  "permission",
  "model_not_found",
  "rate_limit",
  "transient",
  "upstream_5xx",
  "network",
]);

function _safeText(value, maxLength = 120) {
  return String(value == null ? "" : value)
    .replace(/\bAuthorization\s*:[^\r\n]*/gi, "Authorization: [凭据已隐藏]")
    .replace(
      /\b(?:Bearer|Basic|Digest|Token|Api[-_ ]?Key)\s+[A-Za-z0-9._~+/-]+=*/gi,
      "[凭据已隐藏]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/gi, "[凭据已隐藏]")
    .replace(/(?<![A-Za-z0-9._~%+:/-])(?:file:\/\/)?\/(?!\/)[^\s,;)}\]]+/gi, "[路径已隐藏]")
    .replace(/\b[A-Za-z]:[\\/][^\s,;)}\]]*/g, "[路径已隐藏]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function _planId(value) {
  const safe = _safeText(value, 96);
  if (/^[A-Za-z0-9._-]{1,96}$/.test(safe)) return safe;
  return `plan-${crypto.randomBytes(12).toString("hex")}`;
}

function _pricing(provider) {
  const inPer1k = Number(provider && provider.pricing && provider.pricing.inPer1k);
  const outPer1k = Number(provider && provider.pricing && provider.pricing.outPer1k);
  if (!Number.isFinite(inPer1k) || !Number.isFinite(outPer1k) || inPer1k < 0 || outPer1k < 0) {
    return { known: false, estimatedCostPer1k: null };
  }
  return { known: true, estimatedCostPer1k: inPer1k * 0.7 + outPer1k * 0.3 };
}

function _configuredCandidates(candidates, providers) {
  return (Array.isArray(candidates) ? candidates : []).slice(0, MAX_CANDIDATES).map((entry, index) => {
    const target = entry && entry.target && typeof entry.target === "object" ? entry.target : {};
    const providerKey = String(target.provider || "");
    const modelKey = String(target.model || "");
    const provider = _safeText(providerKey);
    const model = _safeText(modelKey);
    const price = _pricing(providers && providers[providerKey]);
    return {
      provider,
      model,
      source: _safeText(entry && entry.source, 40),
      actualPriority: index + 1,
      estimatedCostPer1k: price.estimatedCostPer1k,
      _compatible: target.compatible !== false,
      _providerKey: providerKey,
      _modelKey: modelKey,
    };
  });
}

function _publicCandidate(candidate) {
  const { _compatible, _providerKey, _modelKey, ...safe } = candidate;
  return safe;
}

function _factorSnapshot(value) {
  const factors = {};
  for (const name of routingProfiles.factorNames()) {
    const number = Number(value && value[name]);
    factors[name] = Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
  }
  return factors;
}

function _circuitFor(circuits, provider, model) {
  if (!circuits) return null;
  for (const key of [`${provider}|${model}`, `${provider}|*`]) {
    const value = typeof circuits.get === "function" ? circuits.get(key) : circuits[key];
    if (value) return value;
  }
  return null;
}

function _circuitCategory(value) {
  const normalized = _safeText(value, 40);
  return CIRCUIT_CATEGORIES.has(normalized) ? normalized : "unknown";
}

function _remainingMs(circuit, now) {
  const value = Number(circuit && circuit.until) - now;
  return Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_CIRCUIT_REMAINING_MS, value))
    : null;
}

function _qualify(configured, providers, circuits, now) {
  const dispatchOrder = [];
  const excluded = [];
  for (const candidate of configured) {
    const providerKey = candidate._providerKey || candidate.provider;
    const modelKey = candidate._modelKey || candidate.model;
    const provider = providers && providers[providerKey];
    let reason = null;
    let circuit = null;
    if (!provider) reason = "missing_provider";
    else if (provider.enabled === false) reason = "disabled";
    else if (candidate._compatible === false) reason = "incompatible";
    else {
      circuit = _circuitFor(circuits, providerKey, modelKey);
      if (circuit && Number(circuit.until) > now) reason = "circuit_open";
    }
    if (!reason) {
      dispatchOrder.push(_publicCandidate(candidate));
      continue;
    }
    excluded.push({
      ..._publicCandidate(candidate),
      reason,
      message: {
        missing_provider: "渠道不存在",
        disabled: "渠道已停用",
        circuit_open: "渠道暂时熔断",
        incompatible: "渠道与本次能力要求不兼容",
      }[reason],
      ...(reason === "circuit_open"
        ? {
            circuitCategory: _circuitCategory(circuit && circuit.reason),
            remainingMs: _remainingMs(circuit, now),
          }
        : {}),
    });
  }
  return { dispatchOrder, excluded };
}

function _safeBudget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const capUsd = Number(value.capUsd);
  const fallback = value.fallback === "cheapest" ? "cheapest" : value.fallback === "strict" ? "strict" : null;
  if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > 1000 || !fallback) return null;
  return { capUsd, fallback };
}

function _evaluateBudget(candidates, providers, request, requestedBudget) {
  const budget = _safeBudget(requestedBudget);
  const plan = routingProfiles.evaluateRequestBudget({
    budget,
    inputTokens: request && request.inputTokens,
    maxOutputTokens: request && request.maxOutputTokens,
    candidates: candidates.map((candidate) => ({
      pricing: providers && providers[candidate.provider] && providers[candidate.provider].pricing,
      maxOutputTokens: request && request.maxOutputTokens,
    })),
  });
  const withEstimates = candidates.map((candidate, index) => ({
    ...candidate,
    estimatedCostUsd: Number.isFinite(plan.estimates[index])
      ? Number(plan.estimates[index].toFixed(6))
      : null,
  }));
  let dispatchOrder = withEstimates;
  if (plan.status === "strict_rejected") dispatchOrder = [];
  if (plan.status === "cheapest_override" && plan.preferredIndex != null) {
    const preferred = withEstimates[plan.preferredIndex];
    dispatchOrder = [preferred, ...withEstimates.filter((candidate) => candidate !== preferred)];
  }
  return {
    dispatchOrder,
    snapshot: {
      status: plan.status,
      capUsd: budget ? budget.capUsd : null,
      fallback: budget ? budget.fallback : null,
      budget_override: plan.status === "cheapest_override" ? "cheapest" : null,
      overBudgetFallback: plan.status === "cheapest_override",
    },
  };
}

function _rankAdvisory(configured, input) {
  const costs = configured
    .map((candidate) => candidate.estimatedCostPer1k)
    .filter((value) => Number.isFinite(value));
  const ranked = channelScorer.rankChannels(
    configured.map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      _priority: candidate.actualPriority,
      _estimatedCostPer1k: candidate.estimatedCostPer1k,
      _freeTier: candidate.estimatedCostPer1k === 0,
    })),
    {
      circuits: input.circuits,
      weights: routingProfiles.weightsForProfile(input.profile),
      costRange: costs.length ? { min: Math.min(...costs), max: Math.max(...costs) } : null,
      cacheAffinityProvider: _safeText(input.cacheAffinityProvider),
      callOpts: {
        stream: !input.request || input.request.stream !== false,
        tools: input.request && input.request.usesTools ? [{}] : [],
        thinkingEnabled: input.request && input.request.thinkingEnabled === true,
        reasoningEffort: _safeText(input.request && input.request.reasoningEffort, 24),
      },
    },
  );
  const configuredByKey = new Map(
    configured.map((candidate) => [`${candidate.provider}|${candidate.model}`, candidate]),
  );
  return ranked.map((candidate, index) => {
    const configuredCandidate = configuredByKey.get(`${candidate.provider}|${candidate.model}`);
    return {
      ...configuredCandidate,
      advisoryRank: index + 1,
      advisoryScore: Number.isFinite(candidate._score) ? Number(candidate._score.toFixed(6)) : 0,
      factors: _factorSnapshot(candidate._scoreBreakdown),
    };
  });
}

function createRoutePlan(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const profile = routingProfiles.normalizeProfile(input.profile);
  const configuredWithMeta = _configuredCandidates(input.candidates, input.providers || {});
  const configuredOrder = configuredWithMeta.map(_publicCandidate);
  const qualification = _qualify(
    configuredWithMeta,
    input.providers || {},
    input.circuits,
    now,
  );
  const budget = _evaluateBudget(
    qualification.dispatchOrder,
    input.providers || {},
    input.request || {},
    input.budget,
  );
  const warnings = [];
  if (!qualification.dispatchOrder.length) {
    warnings.push({ code: "all_unavailable", message: "当前没有可尝试的渠道" });
  }
  if (budget.snapshot.status === "strict_rejected") {
    warnings.push({ code: "budget_rejected", message: "所有已知渠道都超过本次预算" });
  }
  if (budget.snapshot.status === "unverified") {
    warnings.push({ code: "budget_unverified", message: "部分渠道缺少价格，暂时无法验证预算" });
  }
  return {
    planId: _planId(input.planId),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
    mode: input.mode === "dispatch" ? "dispatch" : "preflight",
    model: _safeText(input.model),
    profile,
    strategy: input.strategy === "random" ? "random" : "priority",
    configuredOrder,
    dispatchOrder: budget.dispatchOrder,
    excluded: qualification.excluded,
    advisoryOrder: _rankAdvisory(configuredOrder, { ...input, profile }),
    budget: budget.snapshot,
    warnings,
  };
}

module.exports = {
  PLAN_TTL_MS,
  createRoutePlan,
  sanitizeRouteText: _safeText,
};

"use strict";

/**
 * Pure routing-advisory profiles.
 *
 * These weights are an inspection lens only.  The router decides whether a
 * scored result may influence dispatch; priority routing must not do so.
 */

const FACTORS = Object.freeze([
  "health",
  "latency",
  "cost",
  "cacheAffinity",
  "stability",
  "quota",
  "taskFit",
  "priority",
]);

const PROFILE_WEIGHTS = Object.freeze({
  balanced: Object.freeze({
    health: 0.25,
    latency: 0.15,
    cost: 0.1,
    cacheAffinity: 0.15,
    stability: 0.1,
    quota: 0.1,
    taskFit: 0.1,
    priority: 0.05,
  }),
  coding: Object.freeze({
    health: 0.24,
    latency: 0.1,
    cost: 0.06,
    cacheAffinity: 0.2,
    stability: 0.1,
    quota: 0.1,
    taskFit: 0.16,
    priority: 0.04,
  }),
  fast: Object.freeze({
    health: 0.22,
    latency: 0.3,
    cost: 0.05,
    cacheAffinity: 0.05,
    stability: 0.1,
    quota: 0.1,
    taskFit: 0.12,
    priority: 0.06,
  }),
  cheap: Object.freeze({
    health: 0.2,
    latency: 0.1,
    cost: 0.3,
    cacheAffinity: 0.05,
    stability: 0.05,
    quota: 0.1,
    taskFit: 0.1,
    priority: 0.1,
  }),
  reliable: Object.freeze({
    health: 0.35,
    latency: 0.1,
    cost: 0.05,
    cacheAffinity: 0.1,
    stability: 0.2,
    quota: 0.1,
    taskFit: 0.05,
    priority: 0.05,
  }),
  offline: Object.freeze({
    health: 0.15,
    latency: 0.05,
    cost: 0.05,
    cacheAffinity: 0.1,
    stability: 0.2,
    quota: 0.25,
    taskFit: 0.1,
    priority: 0.1,
  }),
});

const PROFILE_IDS = Object.freeze(Object.keys(PROFILE_WEIGHTS));
const MAX_BUDGET_USD = 1000;

function normalizeProfile(profile) {
  const value = String(profile || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROFILE_WEIGHTS, value)
    ? value
    : "balanced";
}

function weightsForProfile(profile) {
  const source = PROFILE_WEIGHTS[normalizeProfile(profile)];
  return Object.freeze({ ...source });
}

function _headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) || undefined;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === expected) return value;
  }
  return undefined;
}

function parseRequestBudget(headers) {
  const rawCap = _headerValue(headers, "x-dao-budget-usd");
  if (rawCap === undefined || rawCap === null || rawCap === "") return null;
  const capUsd = Number(rawCap);
  if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > MAX_BUDGET_USD) return null;

  const rawFallback = String(
    _headerValue(headers, "x-dao-budget-fallback") || "strict",
  )
    .trim()
    .toLowerCase();
  if (rawFallback !== "strict" && rawFallback !== "cheapest") return null;

  return Object.freeze({ capUsd, fallback: rawFallback });
}

function estimateRequestCost({ pricing, inputTokens, maxOutputTokens } = {}) {
  if (inputTokens == null || maxOutputTokens == null) return null;
  const inPer1k = Number(pricing && pricing.inPer1k);
  const outPer1k = Number(pricing && pricing.outPer1k);
  const input = Number(inputTokens);
  const output = Number(maxOutputTokens);
  if (
    !Number.isFinite(inPer1k) ||
    !Number.isFinite(outPer1k) ||
    inPer1k < 0 ||
    outPer1k < 0 ||
    !Number.isFinite(input) ||
    !Number.isFinite(output) ||
    input < 0 ||
    output < 0
  ) {
    return null;
  }
  return (input * inPer1k + output * outPer1k) / 1000;
}

function evaluateRequestBudget({ budget, candidates, inputTokens, maxOutputTokens } = {}) {
  if (!budget) {
    return Object.freeze({
      status: "not_requested",
      reject: false,
      preferredIndex: null,
      estimates: Object.freeze([]),
    });
  }
  const inputs = Array.isArray(candidates) ? candidates : [];
  const estimates = inputs.map((candidate) =>
    estimateRequestCost({
      pricing: candidate && candidate.pricing,
      inputTokens,
      maxOutputTokens:
        candidate && candidate.maxOutputTokens != null
          ? candidate.maxOutputTokens
          : maxOutputTokens,
    }),
  );
  const allKnown = estimates.length > 0 && estimates.every(Number.isFinite);
  const allOverCap = allKnown && estimates.every((estimate) => estimate > budget.capUsd);
  if (!allKnown) {
    return Object.freeze({
      status: "unverified",
      reject: false,
      preferredIndex: null,
      estimates: Object.freeze(estimates.slice()),
    });
  }
  if (!allOverCap) {
    return Object.freeze({
      status: "within_cap",
      reject: false,
      preferredIndex: null,
      estimates: Object.freeze(estimates.slice()),
    });
  }
  if (budget.fallback === "cheapest") {
    const cheapest = estimates.reduce(
      (bestIndex, estimate, index) =>
        estimate < estimates[bestIndex] ? index : bestIndex,
      0,
    );
    return Object.freeze({
      status: "cheapest_override",
      reject: false,
      preferredIndex: cheapest,
      estimates: Object.freeze(estimates.slice()),
    });
  }
  return Object.freeze({
    status: "strict_rejected",
    reject: true,
    preferredIndex: null,
    estimates: Object.freeze(estimates.slice()),
  });
}

function factorNames() {
  return FACTORS.slice();
}

module.exports = {
  FACTORS,
  PROFILE_IDS,
  normalizeProfile,
  weightsForProfile,
  parseRequestBudget,
  estimateRequestCost,
  evaluateRequestBudget,
  factorNames,
};

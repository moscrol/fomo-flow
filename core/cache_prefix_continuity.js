"use strict";

const HASH = /^[a-f0-9]{6,64}$/;

function safeHash(value) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return HASH.test(normalized) ? normalized.slice(0, 64) : "";
}

function evidence(sample) {
  const count = Math.max(0, Math.floor(Number(sample && sample.stableMessageCount) || 0));
  const hashes = (Array.isArray(sample && sample.stableItemHashes)
    ? sample.stableItemHashes
    : [])
    .map(safeHash)
    .filter(Boolean)
    .slice(-256);
  return {
    count,
    hashes,
    start: Math.max(0, count - hashes.length),
  };
}

function isAppendOnly(previous, current) {
  if (current.count < previous.count) return false;
  const overlapStart = Math.max(previous.start, current.start);
  const overlapEnd = Math.min(previous.count, current.count);
  if (overlapEnd <= overlapStart) return false;
  for (let position = overlapStart; position < overlapEnd; position += 1) {
    if (
      previous.hashes[position - previous.start] !==
      current.hashes[position - current.start]
    ) {
      return false;
    }
  }
  return true;
}

function classifyCachePrefixContinuity(samples) {
  const previousByRoute = new Map();
  const generationByRoute = new Map();
  return (Array.isArray(samples) ? samples : []).map((sample) => {
    const provider = String((sample && sample.provider) || "").slice(0, 100);
    const model = String((sample && sample.model) || "").slice(0, 100);
    const route = `${provider}\u0000${model}`;
    const previous = previousByRoute.get(route);
    const currentEvidence = evidence(sample);
    const identity = {
      cacheKeyHash: safeHash(sample && sample.cacheKeyHash),
      cacheFamilyHash: safeHash(sample && sample.cacheFamilyHash),
    };
    let generation = generationByRoute.get(route) || 1;
    let prefixState = "unknown";
    let prefixReason = "insufficient-prefix-evidence";

    if (!previous) {
      prefixState = currentEvidence.hashes.length ? "cold" : "unknown";
      prefixReason = currentEvidence.hashes.length
        ? "first-family-sample"
        : "insufficient-prefix-evidence";
    } else if (
      identity.cacheKeyHash &&
      identity.cacheFamilyHash &&
      (identity.cacheKeyHash !== previous.identity.cacheKeyHash ||
        identity.cacheFamilyHash !== previous.identity.cacheFamilyHash)
    ) {
      generation += 1;
      prefixState = "family-changed";
      prefixReason = "cache-family-changed";
    } else if (!currentEvidence.hashes.length || !previous.evidence.hashes.length) {
      prefixState = "unknown";
      prefixReason = "insufficient-prefix-evidence";
    } else if (isAppendOnly(previous.evidence, currentEvidence)) {
      prefixState = "append-only";
      prefixReason = "stable-prefix-extended";
    } else {
      generation += 1;
      prefixState = "rewritten";
      prefixReason = "stable-prefix-rewritten";
    }

    generationByRoute.set(route, generation);
    previousByRoute.set(route, { evidence: currentEvidence, identity });
    return { prefixState, prefixGeneration: generation, prefixReason };
  });
}

module.exports = { classifyCachePrefixContinuity };

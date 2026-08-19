"use strict";

const GLOBAL_SAMPLE_LIMIT = 50;
const GROUP_SAMPLE_LIMIT = 20;

function finiteNonnegative(value) {
  if (value == null || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function nearestRank(values, quantile) {
  const sorted = (Array.isArray(values) ? values : [])
    .map(finiteNonnegative)
    .filter((value) => value != null)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const parsedQuantile = Number(quantile);
  const bounded = Number.isFinite(parsedQuantile)
    ? Math.min(1, Math.max(0, parsedQuantile))
    : 0.5;
  const rank = Math.max(1, Math.ceil(bounded * sorted.length));
  return sorted[rank - 1];
}

function isObserved(sample) {
  const ttftMs = finiteNonnegative(sample && sample.ttftMs);
  return !!(
    sample &&
    sample.success === true &&
    (sample.firstSignalKind === "text" || sample.firstSignalKind === "tool") &&
    ttftMs != null &&
    ttftMs > 0
  );
}

function summarize(values) {
  const samples = values.filter(isObserved);
  const ttft = samples.map((sample) => finiteNonnegative(sample.ttftMs));
  const duration = samples
    .map((sample) => finiteNonnegative(sample.durationMs))
    .filter((value) => value != null);
  return {
    count: samples.length,
    p50TtftMs: nearestRank(ttft, 0.5),
    p95TtftMs: nearestRank(ttft, 0.95),
    minTtftMs: ttft.length ? Math.min(...ttft) : null,
    maxTtftMs: ttft.length ? Math.max(...ttft) : null,
    p50DurationMs: nearestRank(duration, 0.5),
    p95DurationMs: nearestRank(duration, 0.95),
  };
}

function cacheBucket(sample) {
  const input = finiteNonnegative(sample && sample.input);
  const cached = finiteNonnegative(sample && sample.cached);
  if (input == null || input === 0 || cached == null) return "unknown";
  return cached > 0 ? "hit" : "miss";
}

function safeGroupKey(value) {
  const key = String(value == null ? "" : value).trim().slice(0, 100);
  if (!key || key === "__proto__" || key === "constructor" || key === "prototype") {
    return "unknown";
  }
  return key;
}

function boundedSamples(values, limit) {
  return (Array.isArray(values) ? values : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((sample, index) => ({ sample, index }))
    .sort((left, right) => {
      const leftAt = finiteNonnegative(left.sample.at) || 0;
      const rightAt = finiteNonnegative(right.sample.at) || 0;
      return leftAt - rightAt || left.index - right.index;
    })
    .slice(-limit)
    .map((item) => item.sample);
}

function summarizeSet(samples) {
  return {
    overall: summarize(samples),
    cache: {
      hit: summarize(samples.filter((sample) => cacheBucket(sample) === "hit")),
      miss: summarize(samples.filter((sample) => cacheBucket(sample) === "miss")),
      unknown: summarize(samples.filter((sample) => cacheBucket(sample) === "unknown")),
    },
  };
}

function summarizeGroups(samples, field) {
  const grouped = Object.create(null);
  for (const sample of samples) {
    const key = safeGroupKey(sample[field]);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(sample);
  }
  const output = Object.create(null);
  for (const key of Object.keys(grouped).sort((left, right) => left.localeCompare(right))) {
    output[key] = summarizeSet(grouped[key].slice(-GROUP_SAMPLE_LIMIT));
  }
  return output;
}

function summarizeSamples(values) {
  const samples = boundedSamples(values, GLOBAL_SAMPLE_LIMIT);
  return {
    ...summarizeSet(samples),
    groups: {
      provider: summarizeGroups(samples, "provider"),
      model: summarizeGroups(samples, "model"),
      source: summarizeGroups(samples, "source"),
    },
  };
}

module.exports = {
  nearestRank,
  summarizeSamples,
};

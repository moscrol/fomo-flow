"use strict";

const path = require("node:path");

const DEFAULT_ACTIVE_TTL_MS = 120_000;
const DEFAULT_STALE_TTL_MS = 7_200_000;
const MIN_TTL_MS = 1_000;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function ttl(value, fallback) {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && value.trim() === "")) {
    return fallback;
  }
  let number;
  try {
    number = Number(value);
  } catch {
    return fallback;
  }
  return Number.isFinite(number) && number > 0 ? Math.max(MIN_TTL_MS, number) : fallback;
}

function compactUid(uid) {
  const value = String(uid || "");
  const prefix = "swe-1-6-";
  return value.startsWith(prefix) && value.length > prefix.length
    ? value.slice(prefix.length)
    : value || "?";
}

function hasWarning(summary) {
  const verification = summary && summary.verification || {};
  const failures = summary && summary.failures || {};
  return verification.latestTestStatus === "failed" || verification.blocking === true ||
    Number(failures.sameCallStreak || 0) >= 2 ||
    Number(failures.maxConsecutive || 0) >= 3 ||
    (failures.hasLastError === true && failures.lastToolOk === false);
}

function cleanText(value) {
  return String(value == null ? "" : value).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
}

function limitedText(value, limit) {
  return typeof value === "string" ? cleanText(value).slice(0, limit) : "";
}

function nonnegativeNumber(value) {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && value.trim() === "")) return null;
  let number;
  try {
    number = Number(value);
  } catch {
    return null;
  }
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function optionalNumber(value) {
  const number = nonnegativeNumber(value);
  return number == null ? undefined : number;
}

function sanitizeSummary(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  if (typeof summary.key !== "string") return null;
  const key = summary.key;
  const version = nonnegativeNumber(summary.version);
  const updatedAt = nonnegativeNumber(summary.updatedAt);
  if (!key.trim() || version == null || updatedAt == null) return null;
  const observedAt = nonnegativeNumber(summary.observedAt);

  const activation = summary.activation && typeof summary.activation === "object" ? summary.activation : {};
  const activity = summary.activity && typeof summary.activity === "object" ? summary.activity : {};
  const todo = summary.todo && typeof summary.todo === "object" ? summary.todo : {};
  const verification = summary.verification && typeof summary.verification === "object" ? summary.verification : {};
  const failures = summary.failures && typeof summary.failures === "object" ? summary.failures : {};
  const route = summary.route && typeof summary.route === "object" ? summary.route : {};
  const identity = summary.identity && typeof summary.identity === "object" ? summary.identity : {};
  const workspace = limitedText(summary.workspace, 2_000).replace(/\\/g, "/");

  return {
    key,
    version,
    updatedAt,
    observedAt: observedAt == null ? updatedAt : observedAt,
    identity: { kind: identity.kind === "native" ? "native" : "derived" },
    mode: limitedText(summary.mode, 40),
    activation: {
      state: limitedText(activation.state, 40),
      reason: limitedText(activation.reason, 80),
      activatedAt: optionalNumber(activation.activatedAt),
    },
    activity: {
      requestInFlight: activity.requestInFlight === true,
      lastUpdateAt: optionalNumber(activity.lastUpdateAt),
    },
    goal: limitedText(summary.goal, 120),
    phase: limitedText(summary.phase, 60),
    todo: {
      completed: optionalNumber(todo.completed) || 0,
      total: optionalNumber(todo.total) || 0,
      current: limitedText(todo.current, 100),
    },
    verification: {
      latestTestStatus: limitedText(verification.latestTestStatus, 40),
      blocking: verification.blocking === true,
    },
    failures: {
      maxConsecutive: optionalNumber(failures.maxConsecutive) || 0,
      sameCallStreak: optionalNumber(failures.sameCallStreak) || 0,
      lastToolOk: failures.lastToolOk === false ? false : failures.lastToolOk === true ? true : undefined,
      hasLastError: failures.hasLastError === true,
    },
    route: {
      modelUid: limitedText(route.modelUid, 100),
      provider: limitedText(route.provider, 100),
      upstreamModel: limitedText(route.upstreamModel, 100),
      provisional: route.provisional === true,
    },
    workspace: workspace ? limitedText(path.basename(workspace), 120) : "",
  };
}

function createAgentHudController(options = {}) {
  if (!options || typeof options !== "object") options = {};
  const summaries = new Map();
  const now = typeof options.now === "function" ? options.now : Date.now;
  const readPinnedKey = typeof options.readPinnedKey === "function" ? options.readPinnedKey : () => null;
  const writePinnedKey = typeof options.writePinnedKey === "function" ? options.writePinnedKey : () => {};
  let activeTtlMs = ttl(options.activeTtlMs, DEFAULT_ACTIVE_TTL_MS);
  let staleTtlMs = ttl(options.staleTtlMs, DEFAULT_STALE_TTL_MS);
  staleTtlMs = Math.max(staleTtlMs, activeTtlMs);
  let pinnedKey = null;
  try {
    const restoredKey = readPinnedKey();
    if (typeof restoredKey === "string" && restoredKey) pinnedKey = restoredKey;
  } catch {
    pinnedKey = null;
  }

  function isStale(summary, current = now()) {
    const observedAt = Number(summary.observedAt);
    return !Number.isFinite(observedAt) || current - observedAt > staleTtlMs;
  }

  function isActive(summary, current = now()) {
    if (!summary.activation || summary.activation.state !== "active") return false;
    if (summary.mode === "on") return true;
    const activity = summary.activity || {};
    if (activity.requestInFlight === true) return true;
    const lastUpdateAt = Number(activity.lastUpdateAt == null ? summary.updatedAt : activity.lastUpdateAt);
    return Number.isFinite(lastUpdateAt) && current - lastUpdateAt <= activeTtlMs;
  }

  function _persistPin(key) {
    pinnedKey = key || null;
    try {
      const result = writePinnedKey(pinnedKey);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Persistence failures must not interrupt HUD projection.
    }
  }

  function prune() {
    const current = now();
    for (const [key, summary] of summaries) {
      if (isStale(summary, current)) summaries.delete(key);
    }
    if (pinnedKey && !summaries.has(pinnedKey)) _persistPin(null);
  }

  function update(summary) {
    const incoming = sanitizeSummary(summary);
    if (!incoming) return false;
    const existing = summaries.get(incoming.key);
    if (existing) {
      if (incoming.version < existing.version) return false;
      if (incoming.version === existing.version) {
        if (incoming.updatedAt < existing.updatedAt) return false;
        if (incoming.updatedAt === existing.updatedAt && incoming.observedAt <= existing.observedAt) return false;
      }
    }
    summaries.set(incoming.key, incoming);
    return true;
  }

  function setPinned(key) {
    _persistPin(key && summaries.has(key) ? key : null);
    return pinnedKey;
  }

  function configure(settings = {}) {
    if (!settings || typeof settings !== "object") settings = {};
    const requestedActive = Object.prototype.hasOwnProperty.call(settings, "activeTtlMs")
      ? ttl(settings.activeTtlMs, activeTtlMs) : activeTtlMs;
    const requestedStale = Object.prototype.hasOwnProperty.call(settings, "staleTtlMs")
      ? ttl(settings.staleTtlMs, staleTtlMs) : staleTtlMs;
    activeTtlMs = requestedActive;
    staleTtlMs = Math.max(requestedStale, activeTtlMs);
  }

  function detail(summary, kind) {
    const route = summary.route || {};
    const provider = route.provisional === true ? "…" : cleanText(route.provider) || "?";
    const todo = summary.todo || {};
    const verification = summary.verification || {};
    const phase = cleanText(summary.phase) || "unknown";
    const completed = Number.isFinite(Number(todo.completed)) ? Number(todo.completed) : 0;
    const total = Number.isFinite(Number(todo.total)) ? Number(todo.total) : 0;
    const testStatus = cleanText(verification.latestTestStatus);
    const verify = !testStatus || testStatus === "unknown" ? "test?" : testStatus;
    const tooltipParts = [cleanText(summary.goal), cleanText(summary.workspace), cleanText(summary.mode)].filter(Boolean);
    if (summary.identity && summary.identity.kind === "derived") tooltipParts.push("identity=derived");
    return {
      kind,
      key: summary.key,
      warning: hasWarning(summary),
      sessions: [clone(summary)],
      dao: {
        text: `$(circuit-board) Dao · ${compactUid(route.modelUid)}→${provider}`,
        tooltip: route.provisional === true ? "Dao route: waiting for provider" : "Dao route",
      },
      agent: {
        text: `$(pulse) Agent · ${phase} · ${completed}/${total} · ${verify}`,
        tooltip: tooltipParts.join(" · "),
        warning: hasWarning(summary),
      },
    };
  }

  function project({ globalMode = "invert" } = {}) {
    prune();
    const current = now();
    const pinned = pinnedKey && summaries.get(pinnedKey);
    if (pinned) return detail(pinned, "pinned");

    const active = [...summaries.values()].filter((summary) => isActive(summary, current));
    if (active.length === 1) return detail(active[0], "single");
    if (active.length >= 2) {
      const warnings = active.filter(hasWarning).length;
      return {
        kind: "multi",
        key: null,
        warning: warnings > 0,
        sessions: [],
        activeCount: active.length,
        warningCount: warnings,
        dao: { text: "$(circuit-board) Dao · multi", tooltip: "Dao: multiple active sessions" },
        agent: { text: `$(pulse) Agent · ${active.length} active · ${warnings} warn`, tooltip: "Agent: multiple active sessions", warning: warnings > 0 },
      };
    }
    return {
      kind: "idle",
      key: null,
      warning: false,
      sessions: [],
      dao: {
        text: `$(circuit-board) Dao · ${limitedText(globalMode, 40) || "invert"}`,
        tooltip: `Dao global mode: ${limitedText(globalMode, 40) || "invert"}`,
      },
      agent: null,
    };
  }

  function list() {
    prune();
    return [...summaries.values()].map(clone);
  }

  return { update, setPinned, configure, project, list, prune };
}

module.exports = { createAgentHudController, hasWarning, compactUid };

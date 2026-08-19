"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const IGNORED_EVENT_TYPES = new Set([
  "agent_message",
  "agent_reasoning",
  "mcp_tool_call_end",
  "patch_apply_end",
  "sub_agent_activity",
  "thread_goal_updated",
  "thread_rolled_back",
  "thread_settings_applied",
  "user_message",
  "web_search_end",
]);
const IGNORED_RESPONSE_TYPES = new Set([
  "agent_message",
  "function_call",
  "function_call_output",
  "message",
  "reasoning",
]);
const IGNORED_RECORD_TYPES = new Set([
  "compacted",
  "inter_agent_communication_metadata",
  "world_state",
]);

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex")
    .slice(0, 24);
}

function nonnegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function shortText(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function safeText(value, limit) {
  return shortText(value, limit)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/gi, "[redacted]");
}

function workspaceName(value) {
  const normalized = shortText(value, 2_000).replace(/\\/g, "/");
  return normalized ? shortText(path.basename(normalized), 120) : "";
}

function emptySession(rawId, timestamp) {
  return {
    rawId,
    key: `codex:${hash(rawId)}`,
    surface: "codex",
    version: 1,
    updatedAt: timestamp,
    observedAt: timestamp,
    activation: { state: "dormant" },
    activity: { requestInFlight: false, lastUpdateAt: timestamp },
    goal: "Codex task",
    phase: "idle",
    todo: { completed: 0, total: 0, current: "" },
    verification: { latestTestStatus: "unknown", blocking: false },
    failures: {
      maxConsecutive: 0,
      sameCallStreak: 0,
      lastToolOk: null,
      hasLastError: false,
    },
    route: { modelUid: "", provider: "", upstreamModel: "", provisional: true },
    workspace: "",
    cache: {
      observed: false,
      calls: 0,
      input: 0,
      cached: 0,
      cacheWrite: 0,
      hitRate: 0,
      latestAt: 0,
    },
    telemetry: {
      reasoningTokens: 0,
      contextWindow: 0,
      compactions: 0,
      toolName: "",
      loopSource: "rollout",
      modelPath: "unknown",
    },
    task: {
      key: "",
      state: "idle",
      startedAt: 0,
      updatedAt: timestamp,
      completedAt: 0,
    },
  };
}

function safeSummary(session) {
  const { rawId: _rawId, ...safe } = session;
  return JSON.parse(JSON.stringify(safe));
}

function createCodexTelemetryStore(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sessions = new Map();
  const sourceSessions = new Map();
  const diagnostics = { lastEventAt: 0, unknownEvents: 0, parseErrors: 0 };

  function touch(session, timestamp) {
    session.updatedAt = timestamp;
    session.observedAt = timestamp;
    session.activity.lastUpdateAt = timestamp;
    session.version += 1;
  }

  function ingest(record, sourceId = "default") {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      diagnostics.parseErrors += 1;
      return false;
    }

    const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? record.payload
      : {};
    const timestamp = Date.parse(record.timestamp || "") || now();
    diagnostics.lastEventAt = Math.max(diagnostics.lastEventAt, timestamp);

    if (record.type === "session_meta" && payload.session_id) {
      const rawId = String(payload.session_id);
      const key = `codex:${hash(rawId)}`;
      sourceSessions.set(sourceId, key);
      const session = sessions.get(key) || emptySession(rawId, timestamp);
      session.workspace = workspaceName(payload.cwd);
      session.route.provider = shortText(payload.model_provider, 100);
      touch(session, timestamp);
      sessions.set(key, session);
      return true;
    }

    if (
      IGNORED_RECORD_TYPES.has(record.type) ||
      (record.type === "event_msg" && IGNORED_EVENT_TYPES.has(payload.type)) ||
      (record.type === "response_item" && IGNORED_RESPONSE_TYPES.has(payload.type))
    ) {
      return true;
    }

    const key = sourceSessions.get(sourceId);
    const session = key && sessions.get(key);
    if (!session) {
      diagnostics.unknownEvents += 1;
      return false;
    }

    if (record.type === "turn_context") {
      session.route.modelUid = shortText(payload.model, 100);
      session.route.upstreamModel = session.route.modelUid;
      session.telemetry.reasoningEffort = shortText(payload.effort, 20);
      session.workspace = workspaceName(payload.cwd) || session.workspace;
      if (payload.turn_id) {
        session.task.key = `codex-turn:${hash(`${session.rawId}:${payload.turn_id}`)}`;
        session.task.state = "queued";
        session.task.updatedAt = timestamp;
      }
    } else if (record.type === "event_msg" && payload.type === "task_started") {
      if (payload.turn_id) {
        session.task.key = `codex-turn:${hash(`${session.rawId}:${payload.turn_id}`)}`;
      }
      session.task.state = "running";
      session.task.startedAt = timestamp;
      session.task.updatedAt = timestamp;
      session.activation.state = "active";
      session.activity.requestInFlight = true;
      session.phase = "reasoning";
      session.failures.hasLastError = false;
      session.telemetry.contextWindow = nonnegative(payload.model_context_window);
    } else if (record.type === "response_item" && payload.type === "custom_tool_call") {
      session.phase = "using-tool";
      session.telemetry.toolName = shortText(payload.name, 80);
    } else if (record.type === "response_item" && payload.type === "custom_tool_call_output") {
      session.failures.lastToolOk = true;
      session.phase = "reasoning";
    } else if (record.type === "event_msg" && payload.type === "context_compacted") {
      session.phase = "compacting";
      session.telemetry.compactions += 1;
    } else if (record.type === "event_msg" && payload.type === "token_count") {
      const info = payload.info && typeof payload.info === "object" ? payload.info : {};
      const usage = info.last_token_usage && typeof info.last_token_usage === "object"
        ? info.last_token_usage
        : {};
      const input = nonnegative(usage.input_tokens);
      const cached = nonnegative(usage.cached_input_tokens);
      session.cache = {
        observed: true,
        calls: session.cache.calls + 1,
        input,
        cached,
        cacheWrite: nonnegative(usage.cache_write_input_tokens),
        hitRate: input ? Math.round((cached / input) * 1_000) / 10 : 0,
        latestAt: timestamp,
      };
      session.telemetry.reasoningTokens = nonnegative(usage.reasoning_output_tokens);
      session.telemetry.contextWindow =
        nonnegative(info.model_context_window) || session.telemetry.contextWindow;
    } else if (record.type === "event_msg" && payload.type === "task_complete") {
      session.task.state = payload.error ? "failed" : "succeeded";
      session.task.updatedAt = timestamp;
      session.task.completedAt = timestamp;
      session.task.errorCategory = payload.error ? "codex-task-error" : "";
      session.activation.state = "dormant";
      session.activity.requestInFlight = false;
      session.phase = payload.error ? "failed" : "completed";
      session.failures.hasLastError = Boolean(payload.error);
      session.telemetry.ttftMs = nonnegative(payload.time_to_first_token_ms);
      session.telemetry.durationMs = nonnegative(payload.duration_ms);
    } else if (record.type === "event_msg" && payload.type === "turn_aborted") {
      session.task.state = "failed";
      session.task.updatedAt = timestamp;
      session.task.completedAt = timestamp;
      session.task.errorCategory = "codex-turn-aborted";
      session.activation.state = "dormant";
      session.activity.requestInFlight = false;
      session.phase = "failed";
      session.failures.hasLastError = true;
    } else {
      diagnostics.unknownEvents += 1;
      return false;
    }

    touch(session, timestamp);
    return true;
  }

  function list() {
    return [...sessions.values()].map(safeSummary);
  }

  function hydrate(sourceId, summary) {
    if (!summary || !/^codex:[a-f0-9]{24}$/.test(String(summary.key || ""))) return false;
    const restored = JSON.parse(JSON.stringify(summary));
    restored.rawId = "";
    const task = restored.task && typeof restored.task === "object" ? restored.task : {};
    restored.task = {
      key: shortText(task.key, 120),
      state: ["idle", "queued", "running", "succeeded", "failed"].includes(task.state)
        ? task.state
        : "idle",
      startedAt: nonnegative(task.startedAt),
      updatedAt: nonnegative(task.updatedAt) || nonnegative(restored.updatedAt),
      completedAt: nonnegative(task.completedAt),
      errorCategory: safeText(task.errorCategory, 80),
    };
    const current = sessions.get(restored.key);
    if (!current || nonnegative(restored.updatedAt) >= nonnegative(current.updatedAt)) {
      sessions.set(restored.key, restored);
    }
    sourceSessions.set(sourceId, restored.key);
    diagnostics.lastEventAt = Math.max(
      diagnostics.lastEventAt,
      nonnegative(restored.observedAt || restored.updatedAt),
    );
    return true;
  }

  function summaryForSource(sourceId) {
    const key = sourceSessions.get(sourceId);
    return key && sessions.has(key) ? safeSummary(sessions.get(key)) : null;
  }

  function snapshot() {
    const ageMs = diagnostics.lastEventAt
      ? Math.max(0, now() - diagnostics.lastEventAt)
      : 0;
    return {
      sessions: list(),
      health: {
        state: diagnostics.parseErrors
          ? "schema-drift"
          : diagnostics.lastEventAt
            ? ageMs > 120_000 ? "stale" : "live"
            : "off",
        lastEventAt: diagnostics.lastEventAt,
        ageMs,
        unknownEvents: diagnostics.unknownEvents,
        parseErrors: diagnostics.parseErrors,
      },
    };
  }

  return { ingest, hydrate, list, snapshot, summaryForSource };
}

module.exports = { createCodexTelemetryStore };

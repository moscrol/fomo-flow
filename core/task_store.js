"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stateFile } = require("./product_identity");

const VERSION = 1;
const MAX_TASKS = 256;
const MAX_TEXT = 240;
const MAX_ARTIFACTS = 20;
const TERMINAL = new Set(["succeeded", "failed", "timed_out", "cancelled"]);
const STATUSES = new Set([
  "queued",
  "running",
  "detached",
  "succeeded",
  "failed",
  "timed_out",
  "transport_lost",
  "cancelled",
  "unknown",
]);

function defaultSnapshotPath() {
  return (
    stateFile("tasks.json") ||
    path.join(os.homedir(), ".fomo-flow", "tasks.json")
  );
}

function nowValue(now) {
  const value = Number(typeof now === "function" ? now() : now);
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

function text(value, limit = MAX_TEXT) {
  if (value == null) return "";
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/gi, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function integer(value, fallback = null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function safeStatus(value, fallback = "unknown") {
  const status = String(value || "");
  return STATUSES.has(status) ? status : fallback;
}

function safeId(value) {
  const id = text(value, 96).replace(/[^a-zA-Z0-9._:-]/g, "_");
  return id || `job-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

function publicTask(task) {
  if (!task || typeof task !== "object") return null;
  const copy = JSON.parse(JSON.stringify(task));
  copy.attempts = (Array.isArray(copy.attempts) ? copy.attempts : [])
    .slice(-8)
    .map((attempt) => ({
      provider: text(attempt && attempt.provider, 100),
      model: text(attempt && attempt.model, 100),
      fallbackUsed: attempt && attempt.fallbackUsed === true,
      fallbackReason: text(attempt && attempt.fallbackReason, 80),
      toolCallCount: Math.max(0, integer(attempt && attempt.toolCallCount, 0)),
      durationMs: Math.max(0, Number(attempt && attempt.durationMs) || 0),
      errorCategory: text(attempt && attempt.errorCategory, 40),
      at: Number(attempt && attempt.at) > 0 ? Number(attempt.at) : 0,
    }));
  return copy;
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ARTIFACTS).map((item) => {
    if (typeof item === "string") return { ref: text(item, 240) };
    return {
      ref: text(item && (item.ref || item.path || item.url), 240),
      kind: text(item && item.kind, 40),
    };
  }).filter((item) => item.ref);
}

function normalizeResult(input = {}, at) {
  const status = safeStatus(input.status || (input.exitCode === 0 ? "succeeded" : "failed"));
  return {
    status,
    exitCode: integer(input.exitCode),
    errorCategory: text(input.errorCategory, 80),
    stdoutSummary: text(input.stdoutSummary || input.stdout, MAX_TEXT),
    stderrSummary: text(input.stderrSummary || input.stderr, MAX_TEXT),
    artifacts: normalizeArtifacts(input.artifacts),
    finishedAt: Number(input.finishedAt) > 0 ? Number(input.finishedAt) : at,
  };
}

function createTaskStore(options = {}) {
  const filePath = path.resolve(String(options.filePath || defaultSnapshotPath()));
  const now = options.now || Date.now;
  const writeFile = options.writeFile || fs.writeFileSync;
  const renameFile = options.renameFile || fs.renameSync;
  const readFile = options.readFile || fs.readFileSync;
  const mkdir = options.mkdir || fs.mkdirSync;
  const tasks = new Map();
  let loaded = false;

  function persist() {
    const directory = path.dirname(filePath);
    mkdir(directory, { recursive: true });
    const payload = JSON.stringify({
      version: VERSION,
      generatedAt: nowValue(now),
      tasks: [...tasks.values()].slice(-MAX_TASKS),
    }, null, 2);
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    writeFile(temporaryPath, payload, "utf8");
    try {
      const fd = fs.openSync(temporaryPath, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (_) {}
    renameFile(temporaryPath, filePath);
  }

  function load() {
    if (loaded) return;
    loaded = true;
    let parsed;
    try {
      parsed = JSON.parse(readFile(filePath, "utf8"));
    } catch (_) {
      return;
    }
    const records = Array.isArray(parsed && parsed.tasks) ? parsed.tasks : [];
    const at = nowValue(now);
    for (const raw of records.slice(-MAX_TASKS)) {
      if (!raw || typeof raw !== "object") continue;
      const id = safeId(raw.jobId || raw.id);
      const task = {
        jobId: id,
        source: text(raw.source, 40) || "unknown",
        taskType: text(raw.taskType, 80),
        workspace: text(raw.workspace, 240),
        targetWorkspace: text(raw.targetWorkspace || raw.workspace, 240),
        commandSummary: text(raw.commandSummary || raw.command, MAX_TEXT),
        status: safeStatus(raw.status),
        createdAt: Number(raw.createdAt) || at,
        startedAt: Number(raw.startedAt) || null,
        updatedAt: Number(raw.updatedAt) || at,
        lastHeartbeatAt: Number(raw.lastHeartbeatAt) || null,
        leaseMs: Math.max(1_000, Number(raw.leaseMs) || 30_000),
        phase: text(raw.phase, 80),
        progress: text(raw.progress, MAX_TEXT),
        result: raw.result && typeof raw.result === "object" ? normalizeResult(raw.result, at) : null,
        attempts: Array.isArray(raw.attempts) ? raw.attempts.slice(-20) : [],
        recoveryReason: text(raw.recoveryReason, 100),
      };
      if (task.status === "running") {
        task.status = "unknown";
        task.recoveryReason = "dao-restarted";
        task.updatedAt = at;
      }
      tasks.set(id, task);
    }
  }

  function mutate(jobId, operation) {
    load();
    const task = tasks.get(String(jobId || ""));
    if (!task) return { ok: false, reason: "not-found" };
    const result = operation(task);
    if (result && result.changed) {
      task.updatedAt = nowValue(now);
      persist();
    }
    return { ok: true, task: publicTask(task), ...(result || {}) };
  }

  function create(input = {}) {
    load();
    const at = nowValue(now);
    const jobId = safeId(input.jobId);
    if (tasks.has(jobId)) return { ok: false, reason: "already-exists", task: publicTask(tasks.get(jobId)) };
    const task = {
      jobId,
      source: text(input.source, 40) || "unknown",
      taskType: text(input.taskType, 80),
      workspace: text(input.workspace, 240),
      targetWorkspace: text(input.targetWorkspace || input.workspace, 240),
      commandSummary: text(input.commandSummary || input.command, MAX_TEXT),
      status: "queued",
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      lastHeartbeatAt: null,
      leaseMs: Math.max(1_000, Number(input.leaseMs) || 30_000),
      phase: text(input.phase, 80),
      progress: text(input.progress, MAX_TEXT),
      result: null,
      attempts: [],
      recoveryReason: "",
    };
    tasks.set(jobId, task);
    while (tasks.size > MAX_TASKS) tasks.delete(tasks.keys().next().value);
    persist();
    return { ok: true, task: publicTask(task) };
  }

  function start(jobId, input = {}) {
    return mutate(jobId, (task) => {
      if (TERMINAL.has(task.status)) return { changed: false, reason: "terminal" };
      const at = nowValue(now);
      task.status = "running";
      task.startedAt = task.startedAt || at;
      task.lastHeartbeatAt = at;
      task.phase = text(input.phase, 80) || task.phase;
      task.progress = text(input.progress, MAX_TEXT) || task.progress;
      task.recoveryReason = "";
      return { changed: true };
    });
  }

  function heartbeat(jobId, input = {}) {
    return mutate(jobId, (task) => {
      if (TERMINAL.has(task.status)) return { changed: false, reason: "terminal" };
      const at = nowValue(now);
      task.status = "running";
      task.startedAt = task.startedAt || at;
      task.lastHeartbeatAt = at;
      task.phase = text(input.phase, 80) || task.phase;
      task.progress = text(input.progress, MAX_TEXT) || task.progress;
      task.recoveryReason = "";
      return { changed: true };
    });
  }

  function markTransportLost(jobId, input = {}) {
    return mutate(jobId, (task) => {
      if (TERMINAL.has(task.status)) return { changed: false, reason: "terminal" };
      task.status = "transport_lost";
      task.recoveryReason = text(input.reason, 100) || "transport-lost";
      return { changed: true };
    });
  }

  function reconcile(at = nowValue(now)) {
    load();
    let changed = false;
    for (const task of tasks.values()) {
      if (task.status !== "running" || !task.lastHeartbeatAt) continue;
      if (at - task.lastHeartbeatAt <= task.leaseMs) continue;
      task.status = "detached";
      task.recoveryReason = "heartbeat-expired";
      task.updatedAt = at;
      changed = true;
    }
    if (changed) persist();
    return { changed, tasks: list() };
  }

  function result(jobId, input = {}) {
    return mutate(jobId, (task) => {
      const next = normalizeResult(input, nowValue(now));
      if (TERMINAL.has(task.status)) {
        const same = task.result && task.result.status === next.status &&
          task.result.exitCode === next.exitCode;
        return { changed: false, reason: same ? "idempotent" : "terminal" };
      }
      task.status = next.status;
      task.result = next;
      task.lastHeartbeatAt = null;
      return { changed: true };
    });
  }

  function addAttempt(jobId, input = {}) {
    return mutate(jobId, (task) => {
      task.attempts.push({
        requestId: text(input.requestId, 100),
        attemptId: text(input.attemptId, 100),
        provider: text(input.provider, 100),
        model: text(input.model, 100),
        fallbackUsed: input.fallbackUsed === true,
        fallbackReason: text(input.fallbackReason, 120),
        toolCallCount: Math.max(0, integer(input.toolCallCount, 0)),
        durationMs: Math.max(0, Number(input.durationMs) || 0),
        errorCategory: text(input.errorCategory, 80),
        at: nowValue(now),
      });
      task.attempts = task.attempts.slice(-20);
      return { changed: true };
    });
  }

  function get(jobId) {
    load();
    reconcile();
    return publicTask(tasks.get(String(jobId || "")));
  }

  function list() {
    load();
    return [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(publicTask);
  }

  function snapshot() {
    load();
    reconcile();
    return { version: VERSION, generatedAt: nowValue(now), tasks: list() };
  }

  load();
  return {
    create,
    start,
    heartbeat,
    markTransportLost,
    reconcile,
    result,
    addAttempt,
    get,
    list,
    snapshot,
    filePath,
  };
}

module.exports = {
  STATUSES,
  TERMINAL,
  createTaskStore,
  defaultSnapshotPath,
};

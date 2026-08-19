"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

function text(value, limit = 160) {
  return String(value == null ? "" : value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/gi, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 24);
}

function workspaceLabel(value) {
  const normalized = text(value, 240).replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized ? path.basename(normalized).slice(0, 120) : "";
}

function taskId(summary) {
  const key = text(summary && summary.task && summary.task.key, 120);
  return key || `codex-turn:${hash(summary && summary.key)}`;
}

function taskState(summary) {
  const task = summary && summary.task && typeof summary.task === "object" ? summary.task : {};
  return text(task.state, 24) || "unknown";
}

function resultFor(summary, state) {
  if (state === "succeeded") {
    return { status: "succeeded", exitCode: 0, errorCategory: "" };
  }
  if (state === "failed") {
    return {
      status: "failed",
      exitCode: 1,
      errorCategory: text(summary && summary.task && summary.task.errorCategory, 80) || "codex-task-failed",
    };
  }
  return null;
}

function createCodexTaskAdapter(options = {}) {
  const store = options.store;
  const source = text(options.source || "codex", 40) || "codex";

  function sync(summaries) {
    if (!store || typeof store.create !== "function") return { changed: 0, tasks: [] };
    let changed = 0;
    const values = Array.isArray(summaries) ? summaries : [];
    for (const summary of values) {
      if (!summary || summary.surface !== "codex") continue;
      if (!summary.task || !summary.task.key) continue;
      const id = taskId(summary);
      const state = taskState(summary);
      const workspace = workspaceLabel(summary.workspace);
      const existing = typeof store.get === "function" ? store.get(id) : null;
      if (!existing) {
        const created = store.create({
          jobId: id,
          source,
          taskType: "codex-turn",
          workspace,
          targetWorkspace: workspace,
          phase: text(summary.phase, 80),
          progress: text(summary.goal, 160),
          leaseMs: 180_000,
        });
        if (created && created.ok) changed += 1;
      }
      if (state === "queued") {
        continue;
      }
      if (state === "running") {
        const result = store.heartbeat(id, {
          phase: text(summary.phase, 80),
          progress: text(summary.goal, 160),
        });
        if (result && result.ok) changed += 1;
        continue;
      }
      const terminal = resultFor(summary, state);
      if (terminal) {
        const result = store.result(id, terminal);
        if (result && result.ok && result.reason !== "idempotent") changed += 1;
      }
    }
    return { changed, tasks: typeof store.list === "function" ? store.list() : [] };
  }

  return { sync };
}

module.exports = { createCodexTaskAdapter, taskId, taskState };

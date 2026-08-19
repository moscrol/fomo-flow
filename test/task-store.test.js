"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTaskStore } = require("../core/task_store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dao-task-store-"));
const filePath = path.join(dir, "tasks.json");
let now = 1_000;

try {
  const store = createTaskStore({ filePath, now: () => now });

  const created = store.create({
    jobId: "job-1",
    source: "devin",
    taskType: "daily-review",
    workspace: "/private/project",
    command: "python3 run_review.py --token Bearer secret-token",
    leaseMs: 1_000,
  });
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.task.status, "queued");
  assert.doesNotMatch(JSON.stringify(created.task), /secret-token/);

  assert.strictEqual(store.start("job-1", { phase: "fetch" }).task.status, "running");
  now = 1_050;
  assert.strictEqual(store.heartbeat("job-1", { progress: "3/10" }).task.progress, "3/10");
  assert.strictEqual(store.get("job-1").status, "running");

  now = 2_200;
  assert.strictEqual(store.get("job-1").status, "detached");
  assert.strictEqual(store.get("job-1").recoveryReason, "heartbeat-expired");
  assert.strictEqual(store.result("job-1", {
    status: "succeeded",
    exitCode: 0,
    stdoutSummary: "completed",
    artifacts: [{ path: "/private/project/report.html", kind: "report" }],
  }).task.status, "succeeded");

  const duplicate = store.result("job-1", { status: "succeeded", exitCode: 0 });
  assert.strictEqual(duplicate.ok, true);
  assert.strictEqual(duplicate.reason, "idempotent");
  assert.strictEqual(store.result("job-1", { status: "failed", exitCode: 1 }).reason, "terminal");

  const second = store.create({ jobId: "job-2", source: "devin", leaseMs: 500 });
  assert.strictEqual(second.ok, true);
  store.start("job-2");
  store.markTransportLost("job-2", { reason: "ssh-disconnected" });
  assert.strictEqual(store.get("job-2").status, "transport_lost");
  assert.strictEqual(store.result("job-2", { status: "succeeded", exitCode: 0 }).task.status, "succeeded");

  store.create({ jobId: "job-3", source: "devin" });
  store.start("job-3");
  store.addAttempt("job-3", {
    requestId: "req-1",
    attemptId: "attempt-1",
    provider: "dao",
    model: "gpt-5.6-sol",
    fallbackUsed: true,
    fallbackReason: "upstream-timeout",
    toolCallCount: 2,
    durationMs: 120,
  });
  const publicAttempt = store.get("job-3").attempts[0];
  assert.strictEqual(publicAttempt.fallbackUsed, true);
  assert.strictEqual(publicAttempt.toolCallCount, 2);
  assert(!Object.prototype.hasOwnProperty.call(publicAttempt, "requestId"));
  assert(!Object.prototype.hasOwnProperty.call(publicAttempt, "attemptId"));

  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.strictEqual(persisted.version, 1);
  assert(!JSON.stringify(persisted).includes("secret-token"));

  const recovered = createTaskStore({ filePath, now: () => 2_000 });
  assert.strictEqual(recovered.get("job-1").status, "succeeded");
  assert.strictEqual(recovered.get("job-2").status, "succeeded");
  assert.strictEqual(recovered.get("job-3").status, "unknown");
  assert.strictEqual(recovered.get("job-3").recoveryReason, "dao-restarted");

  assert.strictEqual(store.create({ jobId: "job-1" }).reason, "already-exists");
  console.log("task store: PASS");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTaskStore } = require("../core/task_store.js");
const { createCodexTaskAdapter, taskId } = require("../core/codex_task_adapter.js");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dao-codex-task-adapter-"));
const store = createTaskStore({
  filePath: path.join(temp, "tasks.json"),
  now: () => 10_000,
});
const adapter = createCodexTaskAdapter({ store });
const running = {
  key: "codex:aaaaaaaaaaaaaaaaaaaaaaaa",
  surface: "codex",
  goal: "Run the finance full review",
  phase: "using-tool",
  workspace: "finance-workspace-private",
  task: {
    key: "codex-turn:bbbbbbbbbbbbbbbbbbbbbbbb",
    state: "running",
  },
};

try {
  assert.strictEqual(adapter.sync([{
    ...running,
    task: { state: "idle" },
  }]).tasks.length, 0, "sessions without an active turn are ignored");

  const first = adapter.sync([running]);
  assert.strictEqual(first.changed, 2, "create plus first heartbeat");
  assert.strictEqual(first.tasks.length, 1);
  assert.strictEqual(first.tasks[0].jobId, taskId(running));
  assert.strictEqual(first.tasks[0].status, "running");
  assert.strictEqual(first.tasks[0].workspace, "finance-workspace-private");
  assert.strictEqual(first.tasks[0].targetWorkspace, "finance-workspace-private");

  const second = adapter.sync([running]);
  assert.strictEqual(second.tasks.length, 1);
  assert.strictEqual(second.tasks[0].status, "running");
  assert.doesNotMatch(JSON.stringify(second.tasks), /Users\/a77|finance-workspace-private\/nested/);

  const succeeded = adapter.sync([{
    ...running,
    task: { ...running.task, state: "succeeded" },
  }]);
  assert.strictEqual(succeeded.tasks[0].status, "succeeded");
  assert.strictEqual(succeeded.tasks[0].result.exitCode, 0);

  const failed = adapter.sync([{
    ...running,
    task: {
      key: "codex-turn:cccccccccccccccccccccccc",
      state: "failed",
      errorCategory: "turn-aborted",
    },
    workspace: "/Users/a77/finance-workspace-private",
  }]);
  assert.strictEqual(failed.tasks.length, 2);
  const failedTask = failed.tasks.find((item) => item.jobId.endsWith("cccccccccccccccccccccccc"));
  assert.strictEqual(failedTask.status, "failed");
  assert.strictEqual(failedTask.result.errorCategory, "turn-aborted");
  assert.doesNotMatch(fs.readFileSync(path.join(temp, "tasks.json"), "utf8"), /\/Users\/a77\/finance-workspace-private/);
  console.log("codex task adapter: PASS");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

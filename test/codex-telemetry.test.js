"use strict";

const assert = require("node:assert");
const { createCodexTelemetryStore } = require("../core/codex_telemetry.js");

const store = createCodexTelemetryStore({ now: () => 2_000_000 });
store.ingest({
  timestamp: "1970-01-01T00:33:19.000Z",
  type: "session_meta",
  payload: {
    session_id: "raw-thread-secret",
    cwd: "/Users/alice/private/repo",
    model_provider: "codex_local_access",
    base_instructions: { text: "must-not-escape" },
  },
}, "rollout-a");
store.ingest({
  type: "turn_context",
  payload: {
    turn_id: "raw-turn-secret",
    model: "gpt-5.6-sol",
    effort: "high",
    cwd: "/Users/alice/private/repo",
  },
}, "rollout-a");
store.ingest({
  type: "event_msg",
  payload: {
    type: "task_started",
    turn_id: "raw-turn-secret",
    started_at: 1_999,
    model_context_window: 353400,
  },
}, "rollout-a");
store.ingest({
  type: "response_item",
  payload: {
    type: "custom_tool_call",
    name: "exec",
    input: "cat /private/secret",
  },
}, "rollout-a");
store.ingest({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      last_token_usage: {
        input_tokens: 1000,
        cached_input_tokens: 800,
        cache_write_input_tokens: 0,
        output_tokens: 120,
        reasoning_output_tokens: 40,
        total_tokens: 1120,
      },
      model_context_window: 353400,
    },
  },
}, "rollout-a");

let summary = store.list()[0];
assert.strictEqual(summary.surface, "codex");
assert.strictEqual(summary.phase, "using-tool");
assert.strictEqual(summary.workspace, "repo");
assert.match(summary.task.key, /^codex-turn:[a-f0-9]{24}$/);
assert.strictEqual(summary.task.state, "running");
assert.strictEqual(summary.cache.hitRate, 80);
assert.strictEqual(summary.telemetry.reasoningTokens, 40);
assert.match(summary.key, /^codex:[a-f0-9]{24}$/);

const serialized = JSON.stringify(store.snapshot());
for (const secret of [
  "raw-thread-secret",
  "raw-turn-secret",
  "must-not-escape",
  "cat /private/secret",
  "/Users/alice/private",
]) {
  assert(!serialized.includes(secret), `snapshot leaked ${secret}`);
}

store.ingest({ type: "event_msg", payload: { type: "context_compacted" } }, "rollout-a");
assert.strictEqual(store.list()[0].telemetry.compactions, 1);
store.ingest({
  type: "event_msg",
  payload: { type: "task_complete", turn_id: "raw-turn-secret", completed_at: 2000 },
}, "rollout-a");
summary = store.list()[0];
assert.strictEqual(summary.phase, "completed");
assert.strictEqual(summary.activity.requestInFlight, false);

for (const record of [
  { type: "response_item", payload: { type: "reasoning", summary: "private reasoning" } },
  { type: "response_item", payload: { type: "message", content: "private answer" } },
  { type: "event_msg", payload: { type: "agent_reasoning", text: "private reasoning" } },
  { type: "event_msg", payload: { type: "mcp_tool_call_end", output: "private output" } },
  { type: "event_msg", payload: { type: "thread_goal_updated", goal: "private goal" } },
  { type: "event_msg", payload: { type: "thread_rolled_back", detail: "private rollback" } },
  { type: "compacted", payload: { content: "private compacted content" } },
  { type: "world_state", payload: { full: "private state" } },
]) {
  assert.strictEqual(store.ingest(record, "rollout-a"), true);
}
assert.strictEqual(store.snapshot().health.unknownEvents, 0, "known content events are ignored, not unknown");
assert(!JSON.stringify(store.snapshot()).includes("private reasoning"));
assert(!JSON.stringify(store.snapshot()).includes("private answer"));
assert(!JSON.stringify(store.snapshot()).includes("private output"));
assert(!JSON.stringify(store.snapshot()).includes("private state"));

store.ingest({ type: "event_msg", payload: { type: "not-a-real-event" } }, "rollout-a");
assert.strictEqual(store.snapshot().health.unknownEvents, 1);

store.ingest({
  type: "session_meta",
  payload: {
    session_id: "second-raw-thread",
    cwd: "/Users/alice/second/repo-b",
    model_provider: "codex_local_access",
  },
}, "rollout-b");
store.ingest({
  type: "event_msg",
  payload: { type: "task_started", turn_id: "second-turn", started_at: 2001 },
}, "rollout-b");
assert.strictEqual(store.list().length, 2);
assert.notStrictEqual(store.list()[0].key, store.list()[1].key);

const failedStore = createCodexTelemetryStore({ now: () => 2_100_000 });
failedStore.ingest({
  type: "session_meta",
  payload: { session_id: "failed-thread", cwd: "/tmp/failed-repo" },
}, "failed-rollout");
failedStore.ingest({
  type: "event_msg",
  payload: { type: "task_complete", error: { message: "private failure detail" } },
}, "failed-rollout");
assert.strictEqual(failedStore.list()[0].phase, "failed");
assert.strictEqual(failedStore.list()[0].failures.hasLastError, true);
assert(!JSON.stringify(failedStore.snapshot()).includes("private failure detail"));

const abortedStore = createCodexTelemetryStore({ now: () => 2_200_000 });
abortedStore.ingest({
  type: "session_meta",
  payload: { session_id: "aborted-thread", cwd: "/tmp/aborted-repo" },
}, "aborted-rollout");
abortedStore.ingest({
  type: "event_msg",
  payload: { type: "task_started" },
}, "aborted-rollout");
abortedStore.ingest({
  type: "event_msg",
  payload: { type: "turn_aborted", reason: "private abort reason" },
}, "aborted-rollout");
assert.strictEqual(abortedStore.list()[0].phase, "failed");
assert.strictEqual(abortedStore.list()[0].activity.requestInFlight, false);
assert.strictEqual(abortedStore.list()[0].failures.hasLastError, true);
assert(!JSON.stringify(abortedStore.snapshot()).includes("private abort reason"));

const legacyStore = createCodexTelemetryStore({ now: () => 2_300_000 });
assert.strictEqual(legacyStore.hydrate("legacy-rollout", {
  key: "codex:dddddddddddddddddddddddd",
  updatedAt: 2_299_000,
  observedAt: 2_299_000,
  phase: "idle",
}), true);
const legacySummary = legacyStore.list()[0];
assert.deepStrictEqual(legacySummary.task, {
  key: "",
  state: "idle",
  startedAt: 0,
  updatedAt: 2_299_000,
  completedAt: 0,
  errorCategory: "",
});
assert.strictEqual(legacyStore.hydrate("invalid-task-state", {
  key: "codex:eeeeeeeeeeeeeeeeeeeeeeee",
  updatedAt: 2_299_100,
  task: { state: "leak-secret", errorCategory: "Bearer legacy-secret" },
}), true);
assert.strictEqual(legacyStore.list()[1].task.state, "idle");
assert(!JSON.stringify(legacyStore.snapshot()).includes("legacy-secret"));

console.log("codex telemetry: PASS");

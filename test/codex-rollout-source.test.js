"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createCodexRolloutSource,
  discoverRecentRollouts,
} = require("../core/codex_rollout_source.js");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dao-codex-rollout-"));
const sessionsRoot = path.join(temp, "sessions");
const day = path.join(sessionsRoot, "2026", "07", "31");
const rollout = path.join(day, "rollout-main.jsonl");
const checkpointPath = path.join(temp, "state", "checkpoints.json");
fs.mkdirSync(day, { recursive: true });

const sessionMeta = {
  timestamp: "2026-07-31T00:59:00.000Z",
  type: "session_meta",
  payload: {
    session_id: "private-rollout-session",
    cwd: "/Users/alice/private/repo",
    model_provider: "codex_local_access",
  },
};
const tokenEvent = {
  timestamp: "2026-07-31T00:59:30.000Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      last_token_usage: {
        input_tokens: 1000,
        cached_input_tokens: 800,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 40,
      },
      model_context_window: 353400,
    },
  },
};

const partialRecord = JSON.stringify({
  timestamp: "2026-07-31T00:59:10.000Z",
  type: "turn_context",
  payload: { turn_id: "private-turn", model: "gpt-5.6-sol", effort: "high" },
});
const splitAt = Math.floor(partialRecord.length / 2);
fs.writeFileSync(
  rollout,
  `${JSON.stringify(sessionMeta)}\n${partialRecord.slice(0, splitAt)}`,
  "utf8",
);

const source = createCodexRolloutSource({
  sessionsRoot,
  checkpointPath,
  now: () => Date.parse("2026-07-31T01:00:00Z"),
  autoStart: false,
});
source.poll();
assert.strictEqual(source.list().length, 1);
assert.strictEqual(source.health().parseErrors, 0, "incomplete trailing JSON is not a parse error");

fs.appendFileSync(
  rollout,
  `${partialRecord.slice(splitAt)}\n${JSON.stringify(tokenEvent)}\n`,
  "utf8",
);
source.poll();
assert.strictEqual(source.list()[0].cache.cached, 800);
assert.strictEqual(source.list()[0].cache.calls, 1);
assert.strictEqual(fs.statSync(checkpointPath).mode & 0o777, 0o600);

const restarted = createCodexRolloutSource({
  sessionsRoot,
  checkpointPath,
  now: () => Date.parse("2026-07-31T01:00:05Z"),
  autoStart: false,
});
restarted.poll();
assert.strictEqual(restarted.list().length, 1);
assert.strictEqual(restarted.list()[0].cache.calls, source.list()[0].cache.calls);

fs.truncateSync(rollout, 0);
fs.writeFileSync(
  rollout,
  `${JSON.stringify(sessionMeta)}\n${JSON.stringify(tokenEvent)}\n`,
  "utf8",
);
assert.doesNotThrow(() => source.poll());

const rotated = `${rollout}.old`;
fs.renameSync(rollout, rotated);
fs.writeFileSync(rollout, `${JSON.stringify(sessionMeta)}\n`, "utf8");
assert.doesNotThrow(() => source.poll());

const previousDay = path.join(sessionsRoot, "2026", "07", "30");
fs.mkdirSync(previousDay, { recursive: true });
const previousRollout = path.join(previousDay, "rollout-previous.jsonl");
fs.writeFileSync(previousRollout, `${JSON.stringify(sessionMeta)}\n`, "utf8");
assert(
  discoverRecentRollouts(sessionsRoot, Date.parse("2026-07-31T01:00:00Z"), 64)
    .some((file) => file.endsWith("rollout-previous.jsonl")),
);

fs.appendFileSync(rollout, "{malformed-json}\n", "utf8");
source.poll();
assert(source.health().parseErrors >= 1);

for (let index = 0; index < 70; index += 1) {
  fs.writeFileSync(path.join(day, `rollout-${index}.jsonl`), "", "utf8");
}
assert.strictEqual(
  discoverRecentRollouts(sessionsRoot, Date.parse("2026-07-31T01:00:00Z"), 64).length,
  64,
);
assert.doesNotThrow(() => source.dispose());
assert.doesNotThrow(() => source.dispose());
assert.doesNotThrow(() => restarted.dispose());

const serializedCheckpoint = fs.readFileSync(checkpointPath, "utf8");
assert(!serializedCheckpoint.includes("private-rollout-session"));
assert(!serializedCheckpoint.includes("/Users/alice/private"));

const orderingRoot = path.join(temp, "ordering-sessions");
const orderingDay = path.join(orderingRoot, "2026", "07", "31");
fs.mkdirSync(orderingDay, { recursive: true });
const oldRollout = path.join(orderingDay, "rollout-old.jsonl");
const newRollout = path.join(orderingDay, "rollout-new.jsonl");
const sharedMeta = {
  timestamp: "2026-07-31T00:00:00.000Z",
  type: "session_meta",
  payload: { session_id: "shared-session", cwd: "/tmp/shared" },
};
fs.writeFileSync(oldRollout, [
  JSON.stringify(sharedMeta),
  JSON.stringify({
    timestamp: "2026-07-31T00:10:00.000Z",
    type: "event_msg",
    payload: { type: "task_complete" },
  }),
  "",
].join("\n"));
fs.writeFileSync(newRollout, [
  JSON.stringify(sharedMeta),
  JSON.stringify({
    timestamp: "2026-07-31T00:20:00.000Z",
    type: "event_msg",
    payload: { type: "task_started" },
  }),
  "",
].join("\n"));
fs.utimesSync(oldRollout, new Date("2026-07-31T00:10:00Z"), new Date("2026-07-31T00:10:00Z"));
fs.utimesSync(newRollout, new Date("2026-07-31T00:20:00Z"), new Date("2026-07-31T00:20:00Z"));
const orderedSource = createCodexRolloutSource({
  sessionsRoot: orderingRoot,
  checkpointPath: path.join(temp, "ordering-checkpoint.json"),
  now: () => Date.parse("2026-07-31T01:00:00Z"),
  autoStart: false,
});
orderedSource.poll();
assert.strictEqual(orderedSource.list()[0].activity.requestInFlight, true);
assert.strictEqual(orderedSource.list()[0].phase, "reasoning");
orderedSource.dispose();

fs.rmSync(temp, { recursive: true, force: true });
console.log("codex rollout source: PASS");

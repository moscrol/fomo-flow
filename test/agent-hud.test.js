"use strict";

const assert = require("node:assert");
const { createAgentHudController, hasWarning, compactUid } = require("../core/agent_hud.js");

(async function main() {
let now = 1_000_000;
let persistedPin = null;
const writes = [];
const hud = createAgentHudController({
  now: () => now,
  readPinnedKey: () => persistedPin,
  writePinnedKey: (key) => {
    persistedPin = key;
    writes.push(key);
  },
});

function summary(key, overrides = {}) {
  const result = {
    key,
    version: 1,
    updatedAt: now,
    identity: { kind: "native", id: `producer-${key}-secret` },
    mode: "auto",
    activation: { state: "active", reason: "tools", activatedAt: now - 100 },
    activity: { requestInFlight: false, lastUpdateAt: now },
    goal: `Goal ${key}`,
    phase: "exploring",
    todo: { completed: 2, total: 5, current: "inspect" },
    verification: { latestTestStatus: "unknown", blocking: false },
    failures: { maxConsecutive: 0, sameCallStreak: 0, lastToolOk: true, hasLastError: false },
    route: { modelUid: "swe-1-6-slow", provider: "ay", upstreamModel: "gpt-5.6-terra", provisional: false },
    workspace: "repo",
  };
  for (const [name, value] of Object.entries(overrides)) {
    result[name] = value && typeof value === "object" && !Array.isArray(value)
      ? { ...result[name], ...value }
      : value;
  }
  return result;
}

let view = hud.project({ globalMode: true });
assert.strictEqual(view.kind, "idle");
assert.strictEqual(view.key, null);
assert.strictEqual(view.agent, null);

hud.update(summary("A"));
view = hud.project({ globalMode: true });
assert.strictEqual(view.kind, "single");
assert.strictEqual(view.key, "A");
assert.strictEqual("session" in view, false);
assert.deepStrictEqual(view.sessions[0].identity, { kind: "native" });
assert.doesNotMatch(JSON.stringify(view), /producer-A-secret/);
assert.match(view.dao.text, /slow→ay/);
assert.match(view.agent.text, /exploring/);
assert.match(view.agent.text, /2\/5/);
assert.match(view.agent.text, /test\?/);

hud.update(summary("B", { phase: "testing", todo: { completed: 4, total: 6, current: "private todo" } }));
view = hud.project({ globalMode: true });
assert.strictEqual(view.kind, "multi");
assert.strictEqual(view.key, null);
assert.match(view.dao.text, /Dao · multi/);
assert.match(view.agent.text, /2 active · 0 warn/);
assert.doesNotMatch(JSON.stringify(view), /exploring|testing|ay|private todo|Goal/);

hud.setPinned("B");
view = hud.project({ globalMode: true });
assert.strictEqual(view.kind, "pinned");
assert.strictEqual(view.key, "B");
assert.match(view.agent.text, /testing/);
assert.strictEqual(persistedPin, "B");

now += 1;
hud.update(summary("B", { version: 2, phase: "verifying", verification: { latestTestStatus: "failed" } }));
view = hud.project({ globalMode: true });
assert.strictEqual(view.agent.warning, true);
assert.strictEqual(view.warning, true);
assert.strictEqual(view.sessions[0].phase, "verifying");

hud.update(summary("B", { version: 1, phase: "changed" }));
assert.strictEqual(hud.project({ globalMode: true }).sessions[0].phase, "verifying");
hud.update(summary("B", { version: 2, updatedAt: now - 1, phase: "older" }));
assert.strictEqual(hud.project({ globalMode: true }).sessions[0].phase, "verifying");
assert.strictEqual(hud.update(summary("B", {
  version: 2,
  updatedAt: now,
  observedAt: now + 100,
  phase: "verifying",
  verification: { latestTestStatus: "failed" },
})), true, "a newer observation may rediscover unchanged domain state");
assert.strictEqual(hud.update(summary("B", {
  version: 2,
  updatedAt: now,
  observedAt: now + 100,
  phase: "verifying",
})), false, "duplicate observations are ignored");

now += 1;
hud.update(summary("B", { version: 3, route: { provisional: true, provider: "should-not-show" } }));
view = hud.project({ globalMode: true });
assert.match(view.dao.text, /slow→…/);
assert.doesNotMatch(view.dao.text, /should-not-show/);
assert.match(view.dao.tooltip, /waiting/i);

assert.strictEqual(compactUid("swe-1-6-slow"), "slow");
assert.strictEqual(compactUid("custom-model-v2"), "custom-model-v2");
assert.strictEqual(hasWarning(summary("w", { verification: { latestTestStatus: "failed" } })), true);
assert.strictEqual(hasWarning(summary("w", { verification: { blocking: true } })), true);
assert.strictEqual(hasWarning(summary("w", { failures: { sameCallStreak: 2 } })), true);
assert.strictEqual(hasWarning(summary("w", { failures: { maxConsecutive: 3 } })), true);
assert.strictEqual(hasWarning(summary("w", { failures: { hasLastError: true, lastToolOk: false } })), true);
assert.strictEqual(hasWarning(summary("ok", { todo: { completed: 0, total: 1, current: "open" } })), false);
assert.strictEqual(hasWarning(summary("ok", { verification: { latestTestStatus: "unknown" }, phase: "exploring" })), false);
assert.strictEqual(hasWarning(summary("ok", { failures: { hasLastError: true, lastToolOk: undefined } })), false);

hud.update(summary("dormant", { activation: { state: "dormant" } }));
hud.update(summary("off", { activation: { state: "off" } }));
hud.setPinned(null);
view = hud.project({ globalMode: true });
assert.match(view.agent.text, /2 active/);

now += 121_000;
hud.update(summary("inflight", { activity: { requestInFlight: true, lastUpdateAt: now - 121_000 } }));
hud.setPinned(null);
view = hud.project({ globalMode: true });
assert.strictEqual(view.kind, "single");
assert.strictEqual(view.key, "inflight");

hud.configure({ activeTtlMs: 1_000, staleTtlMs: 500 });
now += 1;
hud.update(summary("B", { version: 4, phase: "verifying" }));
hud.setPinned("B");

const listed = hud.list();
listed.find((item) => item.key === "B").phase = "corrupted";
view.sessions[0].phase = "also corrupted";
assert.strictEqual(hud.project({ globalMode: true }).sessions[0].phase, "verifying");

now += 1_001;
hud.prune();
assert.strictEqual(hud.list().length, 0);
assert.strictEqual(persistedPin, null);
assert.strictEqual(writes.at(-1), null);

const idleModeHud = createAgentHudController({ now: () => now });
view = idleModeHud.project({ globalMode: "invert" });
assert.match(view.dao.text, /invert/);
assert.match(view.dao.tooltip, /invert/);

const invalidHud = createAgentHudController({ now: () => now });
assert.strictEqual(invalidHud.update(summary("valid", { version: 8, updatedAt: now, phase: "safe" })), true);
assert.strictEqual(invalidHud.update(summary("valid", { version: NaN, updatedAt: now + 1, phase: "nan" })), false);
assert.strictEqual(invalidHud.update(summary("valid", { version: -1, updatedAt: now + 1, phase: "negative" })), false);
assert.strictEqual(invalidHud.update(summary("valid", { version: null, updatedAt: now + 1, phase: "null version" })), false);
assert.strictEqual(invalidHud.update(summary("valid", { version: 9, updatedAt: Infinity, phase: "infinite" })), false);
assert.strictEqual(invalidHud.update(summary("valid", { version: 9, updatedAt: undefined, phase: "missing" })), false);
assert.strictEqual(invalidHud.update(summary("valid", { version: 9, updatedAt: null, phase: "null time" })), false);
assert.strictEqual(invalidHud.update(summary("", { version: 9 })), false);
assert.strictEqual(invalidHud.update(summary("   ", { version: 9 })), false);
assert.strictEqual(invalidHud.update(summary(42, { version: 9 })), false);
assert.strictEqual(invalidHud.project().sessions[0].phase, "safe");

const privateInput = summary("private", {
  version: "2",
  updatedAt: String(now),
  goal: `  private\n goal ${"x".repeat(200)}  `,
  workspace: "/Users/alice/secrets/repo",
  identity: { kind: "derived", id: "full-derived-identity-secret" },
  todo: { current: `inspect-${"y".repeat(150)}` },
  route: { provider: "ay", apiKey: "route-secret" },
  apiKey: "top-secret",
  headers: { authorization: "Bearer secret" },
});
assert.strictEqual(invalidHud.update(privateInput), true);
privateInput.phase = "mutated input";
privateInput.route.provider = "mutated provider";
const safePrivate = invalidHud.list().find((item) => item.key === "private");
assert.strictEqual(safePrivate.version, 2);
assert.strictEqual(safePrivate.updatedAt, now);
assert.strictEqual(safePrivate.observedAt, now);
assert.strictEqual(safePrivate.workspace, "repo");
assert.deepStrictEqual(safePrivate.identity, { kind: "derived" });
assert.ok(safePrivate.goal.length <= 120);
assert.doesNotMatch(safePrivate.goal, /\n/);
assert.ok(safePrivate.todo.current.length <= 100);
assert.strictEqual(safePrivate.route.provider, "ay");
assert.strictEqual("apiKey" in safePrivate, false);
assert.strictEqual("headers" in safePrivate, false);
assert.strictEqual("apiKey" in safePrivate.route, false);
assert.strictEqual("id" in safePrivate.identity, false);
invalidHud.setPinned("private");
const privateProjection = invalidHud.project();
assert.match(privateProjection.agent.tooltip, /identity=derived/);
assert.doesNotMatch(JSON.stringify(privateProjection), /top-secret|route-secret|Bearer secret|full-derived-identity-secret|\/Users\/alice\/secrets/);
safePrivate.route.provider = "corrupted list";
privateProjection.sessions[0].route.provider = "corrupted projection";
assert.strictEqual(invalidHud.list().find((item) => item.key === "private").route.provider, "ay");

invalidHud.update(summary("invalid-identity", {
  identity: { kind: "admin", id: "invalid-kind-secret" },
}));
const invalidIdentity = invalidHud.list().find((item) => item.key === "invalid-identity");
assert.deepStrictEqual(invalidIdentity.identity, { kind: "derived" });
assert.doesNotMatch(JSON.stringify(invalidIdentity), /invalid-kind-secret/);

const restoredHud = createAgentHudController({
  now: () => now,
  readPinnedKey: () => "restored",
});
restoredHud.update(summary("restored"));
assert.strictEqual(restoredHud.project().kind, "pinned");
assert.strictEqual(restoredHud.project().key, "restored");

const syncThrowHud = createAgentHudController({
  now: () => now,
  writePinnedKey: () => { throw new Error("sync persistence failure"); },
});
syncThrowHud.update(summary("sync"));
assert.doesNotThrow(() => syncThrowHud.setPinned("sync"));
assert.strictEqual(syncThrowHud.project().key, "sync");
now += 7_200_001;
assert.doesNotThrow(() => syncThrowHud.prune());
assert.strictEqual(syncThrowHud.project().kind, "idle");

const rejectedWrites = [];
const rejectedHud = createAgentHudController({
  now: () => now,
  writePinnedKey: (key) => {
    rejectedWrites.push(key);
    return Promise.reject(new Error("async persistence failure"));
  },
});
rejectedHud.update(summary("rejected"));
rejectedHud.setPinned("rejected");
await new Promise((resolve) => setImmediate(resolve));
assert.deepStrictEqual(rejectedWrites, ["rejected"]);
assert.strictEqual(rejectedHud.project().key, "rejected");
now += 7_200_001;
assert.doesNotThrow(() => rejectedHud.prune());
await new Promise((resolve) => setImmediate(resolve));
assert.deepStrictEqual(rejectedWrites, ["rejected", null]);
assert.strictEqual(rejectedHud.project().kind, "idle");

const ttlHud = createAgentHudController({ now: () => now, activeTtlMs: 2_000, staleTtlMs: 4_000 });
ttlHud.update(summary("ttl"));
ttlHud.configure(null);
ttlHud.configure({ activeTtlMs: null, staleTtlMs: false });
ttlHud.configure({ activeTtlMs: "", staleTtlMs: NaN });
ttlHud.configure({ activeTtlMs: -10, staleTtlMs: -20 });
assert.doesNotThrow(() => ttlHud.configure({ activeTtlMs: Symbol("bad") }));
now += 1_500;
assert.strictEqual(ttlHud.project().kind, "single");
now += 501;
assert.strictEqual(ttlHud.project().kind, "idle");
assert.strictEqual(ttlHud.list().length, 1);
ttlHud.configure({ activeTtlMs: 5_000, staleTtlMs: 1_000 });
now += 2_000;
assert.strictEqual(ttlHud.list().length, 1);
now += 1_001;
assert.strictEqual(ttlHud.list().length, 0);

const manualOnHud = createAgentHudController({
  now: () => now,
  activeTtlMs: 1_000,
  staleTtlMs: 10_000,
});
manualOnHud.update(summary("manual-auto", {
  mode: "auto",
  activity: { requestInFlight: false, lastUpdateAt: now - 5_000 },
}));
assert.strictEqual(manualOnHud.project().kind, "idle");
manualOnHud.update(summary("manual-on", {
  mode: "on",
  activity: { requestInFlight: false, lastUpdateAt: now - 5_000 },
}));
assert.strictEqual(
  manualOnHud.project().kind,
  "single",
  "manual On must stay visible beyond the active TTL",
);
assert.strictEqual(manualOnHud.project().key, "manual-on");

console.log("agent HUD controller: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

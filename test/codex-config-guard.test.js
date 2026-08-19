"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const codex = require("../vendor/外接api/core/codex_hot_route");

async function main() {
  let calls = 0;
  let release = null;
  const logs = [];
  const handle = codex.startConfigGuard({
    initialDelayMs: 60_000,
    intervalMs: 60_000,
    baseUrl: "http://127.0.0.1:8955/codex-hot/v1",
    getApiKey: () => "loopback-secret",
    log: (line) => logs.push(String(line)),
    reconcile: () => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });

  const firstTick = handle.tick();
  const busyTick = await handle.tick();
  assert.deepStrictEqual(busyTick, {
    ok: false,
    state: "busy",
    changed: false,
  });
  assert.strictEqual(calls, 1, "overlapping ticks must not enter reconciliation");
  release({ ok: true, state: "managed", changed: false });
  assert.deepStrictEqual(await firstTick, {
    ok: true,
    state: "managed",
    changed: false,
  });
  assert.strictEqual(logs.length, 1, "first state is logged once");

  handle.stop();
  assert.deepStrictEqual(await handle.tick(), {
    ok: false,
    state: "stopped",
    changed: false,
  });
  assert.strictEqual(calls, 1);

  let priorCalls = 0;
  const prior = codex.startConfigGuard({
    initialDelayMs: 60_000,
    intervalMs: 60_000,
    getApiKey: () => "first",
    reconcile: () => {
      priorCalls += 1;
      return { ok: true, state: "managed", changed: false };
    },
  });
  const replacement = codex.startConfigGuard({
    initialDelayMs: 60_000,
    intervalMs: 60_000,
    getApiKey: () => "second",
    reconcile: () => ({ ok: true, state: "managed", changed: false }),
  });
  assert.deepStrictEqual(await prior.tick(), {
    ok: false,
    state: "stopped",
    changed: false,
  });
  assert.strictEqual(priorCalls, 0, "starting a replacement stops the prior guard");
  codex.stopConfigGuard();
  assert.deepStrictEqual(await replacement.tick(), {
    ok: false,
    state: "stopped",
    changed: false,
  });

  const source = fs.readFileSync(
    path.join(__dirname, "..", "vendor", "bundled-origin", "source.js"),
    "utf8",
  );
  assert.match(source, /startConfigGuard\s*\(/);
  assert.match(source, /stopConfigGuard\s*\(/);
  assert.match(source, /getApiKey\s*:/);
  assert.match(source, /codex-hot\/v1/);

  console.log("codex config guard tests: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

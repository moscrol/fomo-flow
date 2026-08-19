"use strict";

const assert = require("node:assert");
const path = require("node:path");

const modulePath =
  process.env.DAO_SWE_GUARD_MODULE ||
  path.join(
    __dirname,
    "..",
    "vendor",
    "外接api",
    "core",
    "swe_route_guard.js",
  );
const guard = require(modulePath);

assert.strictEqual(
  guard.resolveProviderEndpoint(
    {
      baseUrl: "https://kfcoding.codes",
      completionPath: "/v1/chat/completions",
    },
    "openai-chat",
  ),
  "https://kfcoding.codes/v1/chat/completions",
);

assert.strictEqual(
  guard.resolveProviderEndpoint(
    {
      baseUrl: "https://example.test/v1/chat/completions",
    },
    "openai-chat",
  ),
  "https://example.test/v1/chat/completions",
);

assert.strictEqual(
  guard.resolveProviderEndpoint(
    { baseUrl: "https://example.test/" },
    "openai-chat",
  ),
  "https://example.test/v1/chat/completions",
);

const timers = { first: new Set(), interval: new Set() };
const timerFns = {
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout,
  setInterval: global.setInterval,
  clearInterval: global.clearInterval,
};
global.setTimeout = (fn) => {
  const handle = { fn, unref() {} };
  timers.first.add(handle);
  return handle;
};
global.clearTimeout = (handle) => timers.first.delete(handle);
global.setInterval = (fn) => {
  const handle = { fn, unref() {} };
  timers.interval.add(handle);
  return handle;
};
global.clearInterval = (handle) => timers.interval.delete(handle);

try {
  guard.startSweRouteGuard({ intervalMs: 30_000, log: () => {} });
  assert.strictEqual(timers.first.size, 1);
  assert.strictEqual(timers.interval.size, 1);

  delete require.cache[require.resolve(modulePath)];
  const reloadedGuard = require(modulePath);
  reloadedGuard.startSweRouteGuard({ intervalMs: 30_000, log: () => {} });
  assert.strictEqual(timers.first.size, 1, "热重载不得遗留首次探活定时器");
  assert.strictEqual(timers.interval.size, 1, "热重载不得遗留周期探活定时器");
  reloadedGuard.stopSweRouteGuard();
  assert.strictEqual(timers.first.size, 0);
  assert.strictEqual(timers.interval.size, 0);
} finally {
  global.setTimeout = timerFns.setTimeout;
  global.clearTimeout = timerFns.clearTimeout;
  global.setInterval = timerFns.setInterval;
  global.clearInterval = timerFns.clearInterval;
}

console.log("swe route guard endpoint tests: PASS");

"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createWebHudService } = require("../core/web_hud_service.js");

class FakeResponse extends EventEmitter {
  constructor(writeResult = true) {
    super();
    this.chunks = [];
    this.writeResult = writeResult;
    this.writableEnded = false;
    this.destroyed = false;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return this.writeResult;
  }
}

let now = 10_000;
let timerCallback = null;
let timerCreated = 0;
let timerCleared = 0;
let value = 1;
let usageFailure = false;

const service = createWebHudService({
  now: () => now,
  readers: {
    runtime: () => ({ healthy: true, mode: "invert", port: 8955 }),
    agentSummaries: () => [],
    codexSummaries: () => [{ key: "codex:safe" }],
    codexHealth: () => ({ state: "live" }),
    codexRoute: () => ({ routeActive: true }),
    routerStatus: () => ({ ready: true }),
    usage: () => {
      if (usageFailure) throw new Error("sk-private upstream message");
      return { ay: { calls: value, input: value * 10 } };
    },
  },
  project(input) {
    return Object.freeze({
      version: 1,
      generatedAt: input.now,
      value: input.usage.ay ? input.usage.ay.calls : 0,
      codexCount: input.codexSummaries.length,
      codexState: input.codexHealth.state,
      codexRouteActive: input.codexRoute.routeActive,
      warnings: input.componentWarnings,
      observability: input.observability || null,
    });
  },
  setInterval(fn, delay) {
    assert.strictEqual(delay, 2_000);
    timerCreated += 1;
    timerCallback = fn;
    return { unref() {} };
  },
  clearInterval(timer) {
    assert(timer);
    timerCleared += 1;
  },
  cadenceMs: 2_000,
  heartbeatMs: 15_000,
  maxClients: 2,
});

const firstSnap = service.snapshot();
assert.strictEqual(firstSnap.version, 1);
assert.strictEqual(firstSnap.generatedAt, now);
assert.strictEqual(firstSnap.value, 1);
assert.strictEqual(firstSnap.codexCount, 1);
assert.strictEqual(firstSnap.codexState, "live");
assert.strictEqual(firstSnap.codexRouteActive, true);
assert.deepStrictEqual(firstSnap.warnings, []);
// Default read path derives observability from usage/codex summaries.
assert(firstSnap.observability && firstSnap.observability.global);
assert.strictEqual(firstSnap.observability.global.routed.calls.value, 1);
assert.strictEqual(firstSnap.observability.global.routed.hitRate.confidence, "medium");
assert.strictEqual(timerCreated, 0, "snapshot reads must not start an interval");

const first = new FakeResponse();
const firstSubscription = service.subscribe(first);
assert.strictEqual(firstSubscription.ok, true);
assert.strictEqual(timerCreated, 1);
assert.strictEqual(service.clientCount(), 1);
assert.match(first.chunks.join(""), /^event: snapshot\ndata: /);
assert.match(first.chunks.join(""), /"value":1/);

const second = new FakeResponse(false);
const secondSubscription = service.subscribe(second);
assert.strictEqual(secondSubscription.ok, true);
assert.strictEqual(timerCreated, 1, "all subscribers must share one timer");
assert.strictEqual(service.clientCount(), 2);

const rejected = service.subscribe(new FakeResponse());
assert.deepStrictEqual(rejected, { ok: false, reason: "client-limit" });

const beforeUnchanged = first.chunks.length;
now += 2_000;
timerCallback();
assert.strictEqual(first.chunks.length, beforeUnchanged, "generatedAt-only changes are coalesced");

value = 2;
now += 2_000;
timerCallback();
assert.strictEqual(first.chunks.length, beforeUnchanged + 1);
assert.match(first.chunks.at(-1), /"value":2/);

const beforeHeartbeat = first.chunks.length;
now += 15_000;
timerCallback();
assert.strictEqual(first.chunks.length, beforeHeartbeat + 1);
assert.match(first.chunks.at(-1), /^: heartbeat 29000\n\n$/);

usageFailure = true;
now += 2_000;
timerCallback();
assert.match(first.chunks.at(-1), /"value":0/);
assert.match(first.chunks.at(-1), /"usage unavailable"/);
assert.doesNotMatch(first.chunks.at(-1), /sk-private|upstream message/);

second.emit("close");
assert.strictEqual(service.clientCount(), 1);
assert.strictEqual(timerCleared, 0);
firstSubscription.dispose();
assert.strictEqual(service.clientCount(), 0);
assert.strictEqual(timerCleared, 1, "last disconnect stops the shared timer");
firstSubscription.dispose();
secondSubscription.dispose();
assert.strictEqual(timerCleared, 1, "disposal is idempotent");

const third = new FakeResponse();
service.subscribe(third);
assert.strictEqual(timerCreated, 2, "a later subscriber restarts one timer");
service.dispose();
assert.strictEqual(service.clientCount(), 0);
assert.strictEqual(timerCleared, 2);
assert.strictEqual(service.subscribe(new FakeResponse()).reason, "disposed");

console.log("web hud service: PASS");

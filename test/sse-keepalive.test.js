"use strict";

const assert = require("node:assert");
const revproxy = require("../vendor/外接api/core/revproxy.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeResponse {
  constructor() {
    this.chunks = [];
    this.writableEnded = false;
    this.destroyed = false;
  }

  writeHead() {}

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end() {
    this.writableEnded = true;
  }
}

async function verifyKeepalive({ emit, heartbeat, firstEvent }) {
  const res = new FakeResponse();
  let handlers;
  emit(
    res,
    "test-model",
    (value) => {
      handlers = value;
    },
    { startDelayMs: 5, intervalMs: 10, maxDurationMs: 500 },
  );

  assert.ok(handlers, "stream emitter must register upstream handlers");
  await wait(35);
  const beforeFirstEvent = res.chunks.filter(heartbeat).length;
  assert.ok(beforeFirstEvent > 0, "initial protocol frames must not stop keepalive");

  firstEvent(handlers);
  await wait(35);
  assert.strictEqual(
    res.chunks.filter(heartbeat).length,
    beforeFirstEvent,
    "the first upstream event must stop keepalive",
  );
  handlers.onEnd();
}

(async () => {
  await verifyKeepalive({
    emit: revproxy._emitOpenAIStream,
    heartbeat: (chunk) =>
      chunk.includes('"choices"') && !chunk.includes('"chat.completion.chunk"'),
    firstEvent: (handlers) => handlers.onText("hello"),
  });

  await verifyKeepalive({
    emit: revproxy._emitAnthropicStream,
    heartbeat: (chunk) => chunk.startsWith("event: ping\n"),
    firstEvent: (handlers) => handlers.onText("hello"),
  });

  console.log("sse keepalive: PASS");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

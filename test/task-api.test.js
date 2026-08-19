"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTaskStore } = require("../core/task_store.js");
const { createTaskApiHandler, taskRoute } = require("../core/task_api.js");

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.writableEnded = false;
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk) {
    if (chunk != null) this.write(chunk);
    this.writableEnded = true;
  }

  body() {
    return this.chunks.join("");
  }

  json() {
    return JSON.parse(this.body() || "{}");
  }
}

function request(url, method, body, remoteAddress = "127.0.0.1") {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  req.headers = { authorization: "Bearer local-test-key" };
  req.socket = { remoteAddress };
  const res = new FakeResponse();
  process.nextTick(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return { req, res };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dao-task-api-"));
  try {
    const store = createTaskStore({ filePath: path.join(dir, "tasks.json"), now: () => 1_000 });
    const handler = createTaskApiHandler({
      store,
      authOk: (req, cfg) => req.headers.authorization === `Bearer ${cfg.apiKey}`,
      loadConfig: () => ({ apiKey: "local-test-key" }),
    });

    assert.deepStrictEqual(taskRoute("/origin/tasks/job-1/heartbeat"), {
      jobId: "job-1",
      action: "heartbeat",
    });
    assert.deepStrictEqual(taskRoute("/origin/tasks"), { jobId: "", action: "" });

    let item = request("/origin/tasks", "POST", {
      jobId: "job-1",
      source: "devin",
      command: "python3 run.py --token Bearer secret-token",
    });
    assert.strictEqual(await handler(item.req, item.res), true);
    assert.strictEqual(item.res.statusCode, 201);
    assert.strictEqual(item.res.json().task.status, "queued");
    assert.doesNotMatch(item.res.body(), /secret-token/);

    item = request("/origin/tasks", "GET");
    await handler(item.req, item.res);
    assert.strictEqual(item.res.statusCode, 200);
    assert.strictEqual(item.res.json().tasks.length, 1);

    item = request("/origin/tasks/job-1/start", "POST", { phase: "fetch" });
    await handler(item.req, item.res);
    assert.strictEqual(item.res.json().task.status, "running");

    item = request("/origin/tasks/job-1/heartbeat", "POST", { progress: "2/4" });
    await handler(item.req, item.res);
    assert.strictEqual(item.res.json().task.progress, "2/4");

    item = request("/origin/tasks/job-1/attempts", "POST", {
      requestId: "req-1",
      attemptId: "a-1",
      provider: "dao",
      model: "gpt-5.6-sol",
      fallbackUsed: true,
      fallbackReason: "timeout",
    });
    await handler(item.req, item.res);
    const attemptResponse = item.res.json();
    assert.strictEqual(attemptResponse.task.attempts[0].fallbackUsed, true);
    assert(!JSON.stringify(attemptResponse).includes("req-1"));
    assert(!JSON.stringify(attemptResponse).includes("a-1"));

    item = request("/origin/tasks/job-1/result", "POST", { status: "succeeded", exitCode: 0 });
    await handler(item.req, item.res);
    assert.strictEqual(item.res.json().task.status, "succeeded");

    item = request("/origin/tasks/job-1", "GET");
    await handler(item.req, item.res);
    assert.strictEqual(item.res.json().task.status, "succeeded");

    item = request("/origin/tasks/job-1", "GET", undefined, "10.0.0.5");
    await handler(item.req, item.res);
    assert.strictEqual(item.res.statusCode, 403);

    item = request("/origin/tasks", "POST", { jobId: "unauthorized" });
    item.req.headers.authorization = "Bearer wrong";
    await handler(item.req, item.res);
    assert.strictEqual(item.res.statusCode, 401);

    item = request("/origin/tasks", "POST", { jobId: "oversized", command: "x".repeat(70_000) });
    await handler(item.req, item.res);
    assert.strictEqual(item.res.statusCode, 413);

    item = request("/origin/tasks", "POST", {});
    await handler(item.req, item.res);
    assert.strictEqual(item.res.statusCode, 201);

    console.log("task api: PASS");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

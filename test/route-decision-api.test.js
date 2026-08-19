"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const router = require("../vendor/外接api/core/dao_router");
const runtime = require("../vendor/外接api/runtime");

function fixture(port = 9) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dao-route-preflight-"));
  const configPath = path.join(directory, "配置.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        primary: {
          enabled: true,
          type: "openai-compatible",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${port}`,
          completionPath: "/v1/chat/completions",
          streamMode: "stream",
          models: ["m1"],
          pricing: { inPer1k: 2, outPer1k: 4 },
        },
        backup: {
          enabled: true,
          type: "openai-compatible",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${port}`,
          completionPath: "/v1/chat/completions",
          streamMode: "stream",
          models: ["m2"],
          pricing: { inPer1k: 1, outPer1k: 1 },
        },
      },
      daoRoutes: {
        enabled: true,
        routes: {
          MODEL_PREFLIGHT: {
            provider: "primary",
            model: "m1",
            fallback: { provider: "backup", model: "m2" },
            channelStrategy: "priority",
            maxOutputTokens: 4_096,
          },
        },
      },
    }),
    "utf8",
  );
  return { directory, configPath };
}

function cascadeResponse() {
  return {
    headersSent: false,
    writableEnded: false,
    chunks: [],
    writeHead(statusCode) {
      this.statusCode = statusCode;
      this.headersSent = true;
    },
    write(chunk) {
      this.chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
    },
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("route preflight uses current local config without provider or routing side effects", () => {
  const { directory, configPath } = fixture();
  try {
    router.init({ configPath, log: () => {} });
    const before = {
      usage: router.usage(),
      circuits: router._test.upstreamCircuits(),
      affinityCount: router._test.conversationAffinityCount(),
      audit: router.getAuditLog(20),
    };
    const result = router.preflightRoute({
      model: "MODEL_PREFLIGHT",
      profile: "balanced",
      inputTokens: 2_000,
      maxOutputTokens: 1_000,
      stream: true,
      usesTools: true,
      thinkingEnabled: false,
      reasoningEffort: "medium",
    });

    assert.equal(result.ok, true);
    assert.equal(result.plan.mode, "preflight");
    assert.deepEqual(
      result.plan.dispatchOrder.map(({ provider, model }) => `${provider}/${model}`),
      ["primary/m1", "backup/m2"],
    );
    assert.match(result.message, /不会发送请求或改变优先级/);
    assert.deepEqual(router.usage(), before.usage);
    assert.deepEqual(router._test.upstreamCircuits(), before.circuits);
    assert.equal(router._test.conversationAffinityCount(), before.affinityCount);
    assert.deepEqual(router.getAuditLog(20), before.audit);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a matching real request appends attempts and outcome to route evidence", async () => {
  let providerHits = 0;
  const server = http.createServer((request, response) => {
    providerHits += 1;
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await listen(server);
  const { directory, configPath } = fixture(server.address().port);
  try {
    router.init({ configPath, log: () => {} });
    const preflight = router.preflightRoute({
      model: "MODEL_PREFLIGHT",
      profile: "balanced",
      stream: true,
      usesTools: false,
      thinkingEnabled: false,
    });
    assert.equal(preflight.ok, true);
    const response = cascadeResponse();
    assert.equal(
      await router.route(
        { headers: { "x-dao-routing-profile": "balanced" } },
        response,
        Buffer.from(
          JSON.stringify({
            modelUid: "MODEL_PREFLIGHT",
            messages: [{ role: "user", content: "PROMPT_SENTINEL" }],
          }),
        ),
        true,
        "MODEL_PREFLIGHT",
      ),
      true,
    );
    assert.equal(providerHits, 1);

    const [evidence] = router.getRouteEvidence(10);
    assert.equal(evidence.linkedPreflightPlanId, preflight.plan.planId);
    assert.equal(evidence.outcome.status, "selected");
    assert.equal(evidence.events.some((event) => event.kind === "attempt"), true);
    assert.equal(JSON.stringify(evidence).includes("PROMPT_SENTINEL"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    await close(server);
  }
});

test("strict dispatch budget returns HTTP 402 before contacting a provider", async () => {
  let providerHits = 0;
  const server = http.createServer((request, response) => {
    providerHits += 1;
    request.resume();
    response.writeHead(500).end();
  });
  await listen(server);
  const { directory, configPath } = fixture(server.address().port);
  try {
    router.init({ configPath, log: () => {} });
    const response = cascadeResponse();
    const handled = await router.route(
      {
        headers: {
          "x-dao-budget-usd": "0.000001",
          "x-dao-budget-fallback": "strict",
        },
      },
      response,
      Buffer.from(
        JSON.stringify({
          modelUid: "MODEL_PREFLIGHT",
          messages: [{ role: "user", content: "budget check" }],
        }),
      ),
      true,
      "MODEL_PREFLIGHT",
    );
    assert.equal(handled, true);
    assert.equal(response.statusCode, 402);
    assert.equal(providerHits, 0);
    const [evidence] = router.getRouteEvidence(1);
    assert.equal(evidence.outcome.status, "budget_rejected");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    await close(server);
  }
});

test("runtime exposes the local decision center facades", () => {
  for (const name of [
    "routerPreflightRoute",
    "routerDecisionInbox",
    "routerAcknowledgeDecision",
    "routerSnoozeDecision",
    "routerRouteEvidence",
  ]) {
    assert.equal(typeof runtime[name], "function", `${name} must be exported`);
  }
});

test("desktop loopback exposes exact decision center HTTP contracts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dao-route-decision-http-"));
  const script = `
    const { DaoDesktopRuntime } = require('./core/dao_desktop_runtime');
    (async () => {
      const runtime = new DaoDesktopRuntime({
        userDataDir: ${JSON.stringify(path.join(root, "user-data"))},
        homeDir: ${JSON.stringify(path.join(root, "home"))},
        runtimeRoot: process.cwd(),
      });
      const status = await runtime.start();
      const unsafe = await fetch(status.url + '/origin/ea/route-preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'MODEL_UNKNOWN', prompt: 'PROMPT_SENTINEL' }),
      });
      const unsafePayload = await unsafe.json();
      const inbox = await fetch(status.url + '/origin/ea/decision-inbox?limit=2');
      const inboxPayload = await inbox.json();
      const evidence = await fetch(status.url + '/origin/ea/route-evidence?limit=2');
      const evidencePayload = await evidence.json();
      const wrongMethod = await fetch(status.url + '/origin/ea/route-preflight');
      const similarPath = await fetch(status.url + '/origin/ea/decision-inbox/not-a-decision/ack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await runtime.stop();
      process.stdout.write('DAO_ROUTE_DECISION_HTTP=' + JSON.stringify({
        unsafeStatus: unsafe.status,
        unsafeCode: unsafePayload && unsafePayload.error && unsafePayload.error.code,
        promptLeaked: JSON.stringify(unsafePayload).includes('PROMPT_SENTINEL'),
        inboxStatus: inbox.status,
        inboxShape: inboxPayload && inboxPayload.ok === true && Array.isArray(inboxPayload.items),
        evidenceStatus: evidence.status,
        evidenceShape:
          evidencePayload && evidencePayload.ok === true && Array.isArray(evidencePayload.evidence),
        wrongMethod: wrongMethod.status,
        similarPath: similarPath.status,
      }) + '\\n');
      process.exit(0);
    })().catch(error => {
      process.stderr.write(String(error && error.stack || error));
      process.exit(1);
    });
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    timeout: 30_000,
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout
      .split("\n")
      .find((value) => value.startsWith("DAO_ROUTE_DECISION_HTTP="));
    assert.ok(line, result.stdout);
    const report = JSON.parse(line.slice("DAO_ROUTE_DECISION_HTTP=".length));
    assert.equal(report.unsafeStatus, 400);
    assert.equal(report.unsafeCode, "INVALID_PREFLIGHT");
    assert.equal(report.promptLeaked, false);
    assert.equal(report.inboxStatus, 200);
    assert.equal(report.inboxShape, true);
    assert.equal(report.evidenceStatus, 200);
    assert.equal(report.evidenceShape, true);
    assert.equal(report.wrongMethod, 404);
    assert.equal(report.similarPath, 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preflight rejects unsafe shapes and decision actions only update local inbox state", () => {
  const { directory, configPath } = fixture();
  try {
    router.init({ configPath, log: () => {} });
    const unsafe = router.preflightRoute({ model: "MODEL_PREFLIGHT", prompt: "PROMPT_SENTINEL" });
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.status, 400);
    assert.equal(router.preflightRoute({ model: "MODEL_UNKNOWN" }).status, 404);

    const rejected = router.preflightRoute({
      model: "MODEL_PREFLIGHT",
      profile: "balanced",
      budgetUsd: 0.000001,
      budgetFallback: "strict",
      inputTokens: 2_000,
      maxOutputTokens: 1_000,
    });
    assert.equal(rejected.plan.budget.status, "strict_rejected");
    const item = router
      .getDecisionInbox(20)
      .find((candidate) => candidate.classification === "budget_rejected");
    assert.ok(item);
    assert.equal(router.acknowledgeDecision(item.id).status, "acknowledged");
    assert.equal(router.snoozeDecision(item.id, 60).status, "snoozed");
    assert.equal(JSON.stringify(router.getDecisionInbox(20)).includes("PROMPT_SENTINEL"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const originalHome = process.env.HOME;
const originalConfig = process.env.DAO_BYOK_CONFIG;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-agent-status-router-"));
const initialConfigPath = path.join(tempHome, "initial-config.json");

function writeConfig(name, value) {
  const destination = path.join(tempHome, name);
  fs.writeFileSync(destination, JSON.stringify(value), "utf8");
  return destination;
}

function noRetry(route) {
  return { ...route, resilience: { sameProviderRetries: 0 } };
}

function config({ providers = {}, routes = {}, agentStatus = true } = {}) {
  return {
    providers,
    daoRoutes: {
      enabled: true,
      agentStatus:
        agentStatus === false
          ? { enabled: false }
          : {
              enabled: true,
              defaultMode: agentStatus === "auto" ? "auto" : "on",
            },
      routes,
    },
  };
}

function rawRequest(modelUid, cascadeId, content = "route this request") {
  return Buffer.from(
    JSON.stringify({
      modelUid,
      cascadeId,
      prompt: "You are a focused coding agent.",
      messages: [{ role: "user", content }],
    }),
  );
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

function provider(port, models) {
  return {
    enabled: true,
    type: "openai-compatible",
    protocol: "openai-chat",
    baseUrl: `http://127.0.0.1:${port}`,
    completionPath: "/v1/chat/completions",
    streamMode: "stream",
    models,
  };
}

fs.writeFileSync(initialConfigPath, "{ invalid json", "utf8");
process.env.HOME = tempHome;
process.env.DAO_BYOK_CONFIG = initialConfigPath;

async function main() {
  const watcherCount = () =>
    process
      ._getActiveHandles()
      .filter((handle) => handle.constructor?.name === "FSWatcher").length;
  const watchersBeforeFacades = watcherCount();
  const router = require("../vendor/外接api/core/dao_router.js");
  const runtime = require("../vendor/外接api/runtime.js");

  assert.strictEqual(typeof router.agentStatusSubscribe, "function");
  assert.strictEqual(typeof router.agentStatusSetMode, "function");
  assert.strictEqual(typeof router.agentStatusOptions, "function");
  assert.strictEqual(typeof router._test.prepareAgentStatus, "function");
  assert.strictEqual(typeof router._test.agentStatusInjectOutbound, "function");
  assert.strictEqual(typeof router._test.recordAgentRoute, "function");
  assert.strictEqual(typeof router._test.finishAgentRequest, "function");
  assert.strictEqual(typeof runtime.agentStatusList, "function");
  assert.strictEqual(typeof runtime.agentStatusSubscribe, "function");
  assert.strictEqual(typeof runtime.agentStatusSetMode, "function");
  assert.strictEqual(typeof runtime.agentStatusOptions, "function");

  router.init({
    configPath: writeConfig("provider-status-config.json", {
      providers: {
        cccc: { agentStatus: { injectOutbound: false } },
        regular: {},
      },
      daoRoutes: { enabled: true, routes: {} },
    }),
    log: () => {},
  });
  assert.strictEqual(
    router._test.agentStatusInjectOutbound({ provider: "cccc" }),
    false,
  );
  assert.strictEqual(
    router._test.agentStatusInjectOutbound({ provider: "regular" }),
    true,
  );
  assert.strictEqual(
    router._test.agentStatusInjectOutbound({
      provider: "cccc",
      agentStatus: { injectOutbound: true },
    }),
    true,
  );

  assert.deepStrictEqual(runtime.agentStatusOptions(), {
    enabled: false,
    hud: { enabled: false },
  });
  fs.writeFileSync(
    initialConfigPath,
    JSON.stringify(config({ agentStatus: false })),
    "utf8",
  );
  const repairedOptions = runtime.agentStatusOptions();
  assert.strictEqual(repairedOptions.enabled, false);
  assert.strictEqual(typeof repairedOptions.defaultMode, "string");
  assert.strictEqual(repairedOptions.hud.enabled, true);
  runtime.agentStatusList();
  const facadeSubscription = runtime.agentStatusSubscribe(() => {});
  runtime.agentStatusSetMode("dao:facade-watch", "off");
  facadeSubscription.dispose();
  assert.ok(
    watcherCount() - watchersBeforeFacades <= 1,
    "repeated runtime facades must initialize at most one config watcher",
  );

  const stubConfigPath = writeConfig(
    "stub-config.json",
    config({
      routes: {
        MODEL_STATUS_STUB: {
          provider: "builtin-stub",
          model: "stub-transport-test",
        },
      },
    }),
  );
  router.init({ configPath: stubConfigPath, log: () => {} });
  let stubUpdate = null;
  const stubSubscription = runtime.agentStatusSubscribe((summary) => {
    if (summary.key === "dao:status-stub") stubUpdate = summary;
  });
  const stubResponse = cascadeResponse();
  assert.strictEqual(
    await router.route(
      {},
      stubResponse,
      rawRequest("MODEL_STATUS_STUB", "status-stub"),
      true,
      "MODEL_STATUS_STUB",
    ),
    true,
  );
  stubSubscription.dispose();
  const stubSummary = router.agentStatusSummary("dao:status-stub");
  assert.strictEqual(stubSummary.identity.kind, "native");
  assert.deepStrictEqual(stubSummary.route, {
    modelUid: "MODEL_STATUS_STUB",
    provider: "builtin-stub",
    upstreamModel: "stub-transport-test",
    provisional: false,
  });
  assert.strictEqual(stubSummary.activity.requestInFlight, false);
  assert.ok(stubUpdate, "real route updates must reach runtime subscribers");
  assert.strictEqual(Object.hasOwn(stubUpdate, "messages"), false);
  assert.strictEqual(Object.hasOwn(stubUpdate, "environment"), false);

  const anonFile = path.join(
    tempHome,
    ".codeium",
    "dao-byok",
    "agent-status",
    "anon.json",
  );
  assert.strictEqual(
    router.agentStatusList().some((summary) => summary.key === "anon"),
    false,
  );
  let anonUpdate = false;
  const anonSubscription = router.agentStatusSubscribe((summary) => {
    if (summary.key === "anon") anonUpdate = true;
  });
  const unstableResponse = cascadeResponse();
  assert.strictEqual(
    await router.route(
      {},
      unstableResponse,
      Buffer.from(
        JSON.stringify({
          modelUid: "MODEL_STATUS_STUB",
          prompt: "You are a focused coding agent.",
          messages: [{ role: "assistant", content: "no stable user identity" }],
        }),
      ),
      true,
      "MODEL_STATUS_STUB",
    ),
    true,
  );
  anonSubscription.dispose();
  assert.strictEqual(anonUpdate, false);
  assert.strictEqual(
    router.agentStatusList().some((summary) => summary.key === "anon"),
    false,
  );
  assert.strictEqual(fs.existsSync(anonFile), false);

  let backupShouldFail = false;
  let primaryHits = 0;
  let backupHits = 0;
  const backupBodies = [];
  const primaryServer = http.createServer((request, response) => {
    primaryHits++;
    request.resume();
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "primary unavailable" } }));
  });
  const backupServer = http.createServer((request, response) => {
    backupHits++;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      backupBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (backupShouldFail) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "backup unavailable" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await Promise.all([listen(primaryServer), listen(backupServer)]);

  try {
    const primaryPort = primaryServer.address().port;
    const backupPort = backupServer.address().port;
    const failoverConfigPath = writeConfig(
      "failover-config.json",
      config({
        providers: {
          primary: provider(primaryPort, ["primary-model"]),
          backup: provider(backupPort, ["backup-model"]),
        },
        routes: {
          MODEL_STATUS_FAILOVER: noRetry({
            provider: "primary",
            model: "primary-model",
            fallback: { provider: "backup", model: "backup-model" },
          }),
        },
      }),
    );
    router.init({ configPath: failoverConfigPath, log: () => {} });
    const failoverResponse = cascadeResponse();
    assert.strictEqual(
      await router.route(
        {},
        failoverResponse,
        rawRequest("MODEL_STATUS_FAILOVER", "status-failover"),
        true,
        "MODEL_STATUS_FAILOVER",
      ),
      true,
    );
    assert.strictEqual(primaryHits, 1);
    assert.strictEqual(backupHits, 1);
    const failoverSummary = router.agentStatusSummary("dao:status-failover");
    assert.deepStrictEqual(failoverSummary.route, {
      modelUid: "MODEL_STATUS_FAILOVER",
      provider: "backup",
      upstreamModel: "backup-model",
      provisional: false,
    });
    assert.strictEqual(failoverSummary.activity.requestInFlight, false);
    const outboundMessages = backupBodies.at(-1).messages;
    assert.match(outboundMessages.at(-1).content, /<agent_status/);
    const [failoverDecision] = router.getRoutingDecisions("balanced", 1);
    assert.deepStrictEqual(
      failoverDecision.candidates.map(({ provider: name, model }) => `${name}/${model}`),
      ["primary/primary-model", "backup/backup-model"],
    );
    assert.deepStrictEqual(failoverDecision.selected, {
      provider: "backup",
      model: "backup-model",
    });

    const budgetConfigPath = writeConfig(
      "budget-config.json",
      config({
        providers: {
          expensive: {
            ...provider(backupPort, ["expensive-model"]),
            pricing: { inPer1k: 10, outPer1k: 10 },
          },
        },
        routes: {
          MODEL_STATUS_BUDGET: {
            provider: "expensive",
            model: "expensive-model",
            maxOutputTokens: 1_000,
          },
        },
      }),
    );
    router.init({ configPath: budgetConfigPath, log: () => {} });
    const hitsBeforeBudget = backupHits;
    const budgetResponse = cascadeResponse();
    assert.strictEqual(
      await router.route(
        {
          headers: {
            "x-dao-budget-usd": "0.01",
            "x-dao-budget-fallback": "strict",
          },
        },
        budgetResponse,
        rawRequest("MODEL_STATUS_BUDGET", "status-budget"),
        true,
        "MODEL_STATUS_BUDGET",
      ),
      true,
    );
    assert.strictEqual(budgetResponse.statusCode, 402);
    assert.strictEqual(backupHits, hitsBeforeBudget, "pre-dispatch budget rejection must not call provider");
    const [budgetDecision] = router.getRoutingDecisions("balanced", 1);
    assert.strictEqual(budgetDecision.outcome.status, "budget_rejected");
    assert.strictEqual(budgetDecision.budget.status, "strict_rejected");

    const dormantConfigPath = writeConfig(
      "dormant-config.json",
      config({
        providers: {
          backup: provider(backupPort, ["dormant-model"]),
        },
        routes: {
          MODEL_STATUS_DORMANT: {
            provider: "backup",
            model: "dormant-model",
          },
        },
        agentStatus: "auto",
      }),
    );
    router.init({ configPath: dormantConfigPath, log: () => {} });
    assert.strictEqual(
      await router.route(
        {},
        cascadeResponse(),
        rawRequest("MODEL_STATUS_DORMANT", "status-dormant", "say hello"),
        true,
        "MODEL_STATUS_DORMANT",
      ),
      true,
    );
    const dormantSummary = router.agentStatusSummary("dao:status-dormant");
    assert.strictEqual(dormantSummary.activation.state, "dormant");
    assert.strictEqual(dormantSummary.route.provider, "backup");
    assert.strictEqual(dormantSummary.route.provisional, false);
    assert.strictEqual(dormantSummary.activity.requestInFlight, false);
    assert.doesNotMatch(backupBodies.at(-1).messages.at(-1).content, /<agent_status/);

    backupShouldFail = true;
    const allFailedConfigPath = writeConfig(
      "all-failed-config.json",
      config({
        providers: {
          "primary-all": provider(primaryPort, ["primary-all-model"]),
          "backup-all": provider(backupPort, ["backup-all-model"]),
        },
        routes: {
          MODEL_STATUS_ALL_FAILED: noRetry({
            provider: "primary-all",
            model: "primary-all-model",
            fallback: {
              provider: "backup-all",
              model: "backup-all-model",
            },
          }),
        },
      }),
    );
    router.init({ configPath: allFailedConfigPath, log: () => {} });
    const primaryHitsBeforeFailure = primaryHits;
    const backupHitsBeforeFailure = backupHits;
    const allFailedResponse = cascadeResponse();
    assert.strictEqual(
      await router.route(
        {},
        allFailedResponse,
        rawRequest("MODEL_STATUS_ALL_FAILED", "status-all-failed"),
        true,
        "MODEL_STATUS_ALL_FAILED",
      ),
      true,
      "readable upstream error should be returned as a Cascade frame",
    );
    assert.strictEqual(primaryHits, primaryHitsBeforeFailure + 1);
    assert.strictEqual(backupHits, backupHitsBeforeFailure + 1);
    const allFailedSummary = router.agentStatusSummary(
      "dao:status-all-failed",
    );
    assert.strictEqual(allFailedSummary.activity.requestInFlight, false);
    assert.strictEqual(allFailedSummary.route.provisional, true);
    assert.strictEqual(allFailedSummary.route.provider, "primary-all");

    backupShouldFail = false;
    const disabledKey = "dao:status-disabled";
    const disabledConfigPath = writeConfig(
      "disabled-config.json",
      config({
        providers: {
          "backup-disabled": provider(backupPort, ["disabled-model"]),
        },
        routes: {
          MODEL_STATUS_DISABLED: {
            provider: "backup-disabled",
            model: "disabled-model",
          },
        },
        agentStatus: false,
      }),
    );
    router.init({ configPath: disabledConfigPath, log: () => {} });
    let disabledEvent = false;
    const disabledSubscription = router.agentStatusSubscribe((summary) => {
      if (summary.key === disabledKey) disabledEvent = true;
    });
    const disabledResponse = cascadeResponse();
    assert.strictEqual(
      await router.route(
        {},
        disabledResponse,
        rawRequest("MODEL_STATUS_DISABLED", "status-disabled"),
        true,
        "MODEL_STATUS_DISABLED",
      ),
      true,
    );
    disabledSubscription.dispose();
    assert.strictEqual(disabledEvent, false);
    assert.strictEqual(
      router.agentStatusList().some((summary) => summary.key === disabledKey),
      false,
    );
    assert.strictEqual(
      fs.existsSync(
        path.join(
          tempHome,
          ".codeium",
          "dao-byok",
          "agent-status",
          `${disabledKey}.json`,
        ),
      ),
      false,
    );
  } finally {
    await Promise.all([close(primaryServer), close(backupServer)]);
  }

  console.log("agent status router facade: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfig === undefined) delete process.env.DAO_BYOK_CONFIG;
    else process.env.DAO_BYOK_CONFIG = originalConfig;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

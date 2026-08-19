"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const router = require("../vendor/外接api/core/dao_router");

function resetChannelMetrics() {
  try {
    require("../vendor/外接api/core/channel_scorer").clearMetrics();
  } catch (_) {}
}

const firstTurn = {
  modelUid: "MODEL_DAO",
  messages: [{ role: "user", content: "inspect the project" }],
};
const toolTurn = {
  ...firstTurn,
  messages: [
    ...firstTurn.messages,
    { role: "assistant", content: "", tool_calls: [{ id: "call-1" }] },
    { role: "tool", tool_call_id: "call-1", content: "done" },
  ],
};

assert.strictEqual(
  router._test.conversationPromptCacheKey({ ...firstTurn, cascadeId: "cascade-1" }),
  "dao:cascade-1",
);
assert.strictEqual(
  router._test.conversationPromptCacheKey(firstTurn),
  router._test.conversationPromptCacheKey(toolTurn),
  "缺少 cascadeId 时，连续工具回合应复用稳定缓存键",
);
assert.notStrictEqual(
  router._test.conversationPromptCacheKey(firstTurn),
  router._test.conversationPromptCacheKey({
    ...firstTurn,
    messages: [{ role: "user", content: "another conversation" }],
  }),
);

const balancePolicy = router._test.upstreamFailurePolicy(
  403,
  "Insufficient account balance",
  {},
);
assert.strictEqual(balancePolicy.open, true);
assert.strictEqual(balancePolicy.providerWide, true);
assert.strictEqual(balancePolicy.reason, "balance");
assert.ok(balancePolicy.ttlMs >= 30 * 60 * 1000);

router._test.openUpstreamCircuit(
  "quota-provider",
  "gpt-5.6-sol",
  403,
  "Insufficient account balance",
  {},
);
assert.strictEqual(
  router._test.getUpstreamCircuit("quota-provider", "another-model").reason,
  "balance",
  "余额不足应熔断整个渠道，而非只熔断单一模型",
);
router._test.clearUpstreamCircuit("quota-provider", "another-model");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dao-cache-resilience-"));
const configPath = path.join(tempDir, "config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    providers: {
      primary: {
        enabled: true,
        type: "openai-compatible",
        baseUrl: "http://127.0.0.1:1",
        models: ["gpt-5.6-sol"],
      },
      sibling: {
        enabled: true,
        type: "openai-compatible",
        baseUrl: "http://127.0.0.1:2",
        models: ["gpt-5.6-sol"],
      },
      unrelated: {
        enabled: true,
        type: "openai-compatible",
        baseUrl: "http://127.0.0.1:3",
        models: ["other-model"],
      },
    },
    daoRoutes: {
      enabled: true,
      resilience: {
        circuit: {
          strikeThreshold: 3,
          strikeWindowMs: 60000,
          restoreAffinity: true,
        },
      },
      routes: {
        MODEL_DAO: { provider: "primary", model: "gpt-5.6-sol" },
      },
    },
  }),
  "utf8",
);
router.init({ configPath, log: () => {} });

const target = { provider: "primary", model: "gpt-5.6-sol" };
const callOpts = { _promptCacheKey: "dao:cascade-1" };
const fallbacks = router._test.autoFallbackTargets(target, callOpts, new Set());
assert.deepStrictEqual(
  fallbacks.map((item) => item.provider),
  [],
  "未由用户显式添加备用渠道时不得扫描并切换 sibling provider",
);

const configuredTarget = {
  ...target,
  autoFallback: true,
  channelPriority: [
    { provider: "primary", model: "gpt-5.6-sol" },
    { provider: "sibling", model: "gpt-5.6-sol" },
  ],
};
const configuredFallbacks = router._test.autoFallbackTargets(
  configuredTarget,
  callOpts,
  new Set(),
);
assert.deepStrictEqual(
  configuredFallbacks.map((item) => item.provider),
  ["sibling"],
  "用户添加的备用渠道应按队列顺序参与故障转移",
);
router._test.rememberConversationProvider(
  configuredTarget,
  callOpts,
  configuredFallbacks[0],
);
assert.strictEqual(
  router._test.stickyConversationTarget(configuredTarget, callOpts).provider,
  "sibling",
  "备用渠道应在同一会话内保持粘性，避免缓存分片漂移",
);

assert.strictEqual(
  router._test.openUpstreamCircuit(
    "sibling",
    "gpt-5.6-sol",
    503,
    "temporary failure",
    {},
  ),
  null,
  "第一次瞬时失败只累计 strike，不应立即熔断",
);
assert.strictEqual(
  router._test.stickyConversationTarget(configuredTarget, callOpts).provider,
  "sibling",
  "未达到阈值时必须保留会话粘性和缓存亲和",
);
assert.strictEqual(
  router._test.openUpstreamCircuit(
    "sibling",
    "gpt-5.6-sol",
    503,
    "temporary failure",
    {},
  ),
  null,
  "第二次瞬时失败仍不应熔断",
);
const transientCircuit = router._test.openUpstreamCircuit(
  "sibling",
  "gpt-5.6-sol",
  503,
  "temporary failure",
  {},
);
assert.strictEqual(transientCircuit.strikes, 3);
assert.strictEqual(
  router._test.stickyConversationTarget(configuredTarget, callOpts),
  null,
  "粘性渠道故障后应自动失效",
);
assert.deepStrictEqual(
  router._test.autoFallbackTargets(configuredTarget, callOpts, new Set()),
  [],
  "熔断中的渠道不得继续参与自动故障切换",
);
router._test.clearUpstreamCircuit("sibling", "gpt-5.6-sol");
assert.strictEqual(
  router._test.stickyConversationTarget(configuredTarget, callOpts).provider,
  "sibling",
  "渠道恢复并清除熔断后应接回暂存的会话亲和",
);

const strictCustomTarget = {
  provider: "primary",
  model: "gpt-5.6-sol",
  _customModel: true,
  _customModelId: "dao",
};
assert.deepStrictEqual(
  router._test.autoFallbackTargets(strictCustomTarget, callOpts, new Set()),
  [],
  "custom models must stay on their selected provider by default",
);
router._test.rememberConversationProvider(
  strictCustomTarget,
  callOpts,
  { ...strictCustomTarget, provider: "sibling" },
);
assert.strictEqual(
  router._test.stickyConversationTarget(strictCustomTarget, callOpts),
  null,
  "an old cross-provider affinity must not override a strict custom model route",
);
router._test.clearUpstreamCircuit("sibling", "gpt-5.6-sol");

const randomTarget = {
  ...configuredTarget,
  channelStrategy: "random",
};
assert.deepStrictEqual(
  router._test
    .orderedConfiguredChannelTargets(randomTarget, () => 0)
    .map((item) => item.provider),
  ["sibling", "primary"],
  "随机策略应能从用户配置渠道中选择非第一项作为首选",
);
router._test.rememberConversationProvider(
  randomTarget,
  { _promptCacheKey: "dao:random-cascade" },
  { provider: "primary", model: "gpt-5.6-sol" },
);
assert.strictEqual(
  router._test.stickyConversationTarget(
    randomTarget,
    { _promptCacheKey: "dao:random-cascade" },
  ).provider,
  "primary",
  "随机首选渠道必须在同一会话内保持，避免每轮打散上下文与缓存",
);

const sharedRouteConfigPath = path.join(tempDir, "shared-route-config.json");
fs.writeFileSync(
  sharedRouteConfigPath,
  JSON.stringify({
    providers: {
      primary: { enabled: true, type: "openai-compatible", baseUrl: "http://127.0.0.1:1", models: ["gpt-5.6-sol"] },
      sibling: { enabled: true, type: "openai-compatible", baseUrl: "http://127.0.0.1:2", models: ["gpt-5.6-sol"] },
    },
    customModels: {
      shared: { id: "shared", provider: "primary", upstreamModel: "gpt-5.6-sol" },
    },
    daoRoutes: {
      enabled: true,
      routes: {
        shared: {
          provider: "primary", model: "gpt-5.6-sol", _customModel: true, _customModelId: "shared",
          autoFallback: true,
          channelPriority: [
            { provider: "primary", model: "gpt-5.6-sol" },
            { provider: "sibling", model: "gpt-5.6-sol" },
          ],
        },
        MODEL_SHARED_CONSUMER: {
          provider: "primary", model: "gpt-5.6-sol", _customModelRef: "shared",
        },
      },
    },
  }),
  "utf8",
);
router.init({ configPath: sharedRouteConfigPath, log: () => {} });
const materializedShared = router.resolveRoute("MODEL_SHARED_CONSUMER").route;
assert.strictEqual(materializedShared._customModelRef, "shared");
assert.deepStrictEqual(
  materializedShared.channelPriority.map((channel) => channel.provider),
  ["primary", "sibling"],
  "引用⑦自定义模型的普通路由必须动态继承完整渠道优先级",
);
const optedInCustomTarget = {
  ...strictCustomTarget,
  autoFallback: true,
  channelPriority: [
    { provider: "primary", model: "gpt-5.6-sol" },
    { provider: "sibling", model: "gpt-5.6-sol" },
  ],
};
assert.deepStrictEqual(
  router._test
    .autoFallbackTargets(optedInCustomTarget, callOpts, new Set())
    .map((item) => item.provider),
  ["sibling"],
  "custom models must fail over only through their configured priority queue",
);

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function runRouteFailoverTest() {
  let primaryHits = 0;
  let siblingHits = 0;
  let siblingShouldFail = false;
  const primaryServer = http.createServer((req, res) => {
    primaryHits++;
    req.resume();
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Insufficient account balance" } }));
  });
  const siblingServer = http.createServer((req, res) => {
    siblingHits++;
    req.resume();
    if (siblingShouldFail) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "backup unavailable" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 90 },
        },
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await Promise.all([listen(primaryServer), listen(siblingServer)]);
  const primaryPort = primaryServer.address().port;
  const siblingPort = siblingServer.address().port;
  const integrationConfigPath = path.join(tempDir, "integration-config.json");
  fs.writeFileSync(
    integrationConfigPath,
    JSON.stringify({
      providers: {
        primary: {
          enabled: true,
          type: "openai-compatible",
          baseUrl: `http://127.0.0.1:${primaryPort}`,
          completionPath: "/v1/chat/completions",
          streamMode: "stream",
          models: ["gpt-5.6-sol"],
        },
        sibling: {
          enabled: true,
          type: "openai-compatible",
          baseUrl: `http://127.0.0.1:${siblingPort}`,
          completionPath: "/v1/chat/completions",
          streamMode: "stream",
          models: ["gpt-5.6-sol"],
        },
      },
      daoRoutes: {
        enabled: true,
        routes: {
          MODEL_DAO: {
            provider: "primary",
            model: "gpt-5.6-sol",
            autoFallback: true,
            channelPriority: [
              { provider: "primary", model: "gpt-5.6-sol" },
              { provider: "sibling", model: "gpt-5.6-sol" },
            ],
          },
        },
      },
    }),
    "utf8",
  );
  router.init({ configPath: integrationConfigPath, log: () => {} });

  const rawBody = Buffer.from(
    JSON.stringify({
      modelUid: "MODEL_DAO",
      prompt: "Use tools carefully.",
      messages: [{ role: "user", content: "inspect the project" }],
      cascadeId: "cascade-route-failover",
    }),
  );
  const makeResponse = () => ({
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
  });

  resetChannelMetrics();
  const scorer = require("../vendor/外接api/core/channel_scorer");
  for (let index = 0; index < 8; index++) scorer.recordFailure("primary", "gpt-5.6-sol", 503);
  for (let index = 0; index < 8; index++) scorer.recordSuccess("sibling", "gpt-5.6-sol", 100, 200);

  const firstResponse = makeResponse();
  assert.strictEqual(
    await router.route({}, firstResponse, rawBody, true, "MODEL_DAO"),
    true,
  );
  assert.strictEqual(primaryHits, 1, "首轮应只尝试一次余额不足渠道");
  assert.strictEqual(siblingHits, 1, "首轮应自动切到同模型健康渠道");
  assert.ok(firstResponse.chunks.length > 0, "备用渠道响应应转换回 Cascade 帧");

  const secondResponse = makeResponse();
  assert.strictEqual(
    await router.route({}, secondResponse, rawBody, true, "MODEL_DAO"),
    true,
  );
  assert.strictEqual(primaryHits, 1, "后续工具回合不得再次撞已熔断渠道");
  assert.strictEqual(siblingHits, 2, "后续工具回合应保持同一备用渠道粘性");

  fs.writeFileSync(
    integrationConfigPath,
    JSON.stringify({
      providers: {
        primary: {
          enabled: true,
          type: "openai-compatible",
          baseUrl: `http://127.0.0.1:${primaryPort}`,
          completionPath: "/v1/chat/completions",
          streamMode: "stream",
          models: ["gpt-5.6-sol"],
        },
        sibling: {
          enabled: true,
          type: "openai-compatible",
          baseUrl: `http://127.0.0.1:${siblingPort}`,
          completionPath: "/v1/chat/completions",
          streamMode: "stream",
          models: ["gpt-5.6-sol"],
        },
      },
      customModels: {
        dao: {
          id: "dao",
          provider: "primary",
          upstreamModel: "gpt-5.6-sol",
        },
      },
      daoRoutes: {
        enabled: true,
        routes: {
          MODEL_DAO: {
            provider: "primary",
            model: "gpt-5.6-sol",
            _customModel: true,
            _customModelId: "dao",
          },
        },
      },
    }),
    "utf8",
  );
  router.init({ configPath: integrationConfigPath, log: () => {} });
  resetChannelMetrics();
  primaryHits = 0;
  siblingHits = 0;
  const strictResponse = makeResponse();
  assert.strictEqual(
    await router.route({}, strictResponse, rawBody, true, "MODEL_DAO"),
    true,
  );
  assert.strictEqual(primaryHits, 1, "strict custom route should call its selected provider");
  assert.strictEqual(
    siblingHits,
    0,
    "strict custom route must not silently call another provider after failure",
  );

  const multiChannelConfig = JSON.parse(
    fs.readFileSync(integrationConfigPath, "utf8"),
  );
  multiChannelConfig.customModels.dao.channels = [
    { provider: "primary", upstreamModel: "gpt-5.6-sol" },
    { provider: "sibling", upstreamModel: "gpt-5.6-sol" },
  ];
  multiChannelConfig.daoRoutes.routes.MODEL_DAO.autoFallback = true;
  multiChannelConfig.daoRoutes.routes.MODEL_DAO.channelPriority = [
    { provider: "primary", model: "gpt-5.6-sol" },
    { provider: "sibling", model: "gpt-5.6-sol" },
  ];
  fs.writeFileSync(
    integrationConfigPath,
    JSON.stringify(multiChannelConfig),
    "utf8",
  );
  router.init({ configPath: integrationConfigPath, log: () => {} });
  resetChannelMetrics();
  primaryHits = 0;
  siblingHits = 0;
  const failoverResponse = makeResponse();
  assert.strictEqual(
    await router.route({}, failoverResponse, rawBody, true, "MODEL_DAO"),
    true,
  );
  assert.strictEqual(primaryHits, 1, "configured primary should be attempted first");
  assert.strictEqual(siblingHits, 1, "configured backup should receive failover traffic");

  siblingShouldFail = true;
  router.init({ configPath: integrationConfigPath, log: () => {} });
  let allFailedEvent = null;
  const onAllFailed = (details) => {
    allFailedEvent = details;
  };
  process.once("dao:custom-model-channels-failed", onAllFailed);
  const allFailedResponse = makeResponse();
  assert.strictEqual(
    await router.route({}, allFailedResponse, rawBody, true, "MODEL_DAO"),
    true,
  );
  assert.ok(allFailedEvent, "all configured channel failures should emit a Devin alert event");
  assert.deepStrictEqual(
    allFailedEvent.channels.map((channel) => channel.provider),
    ["primary", "sibling"],
    "failure alert should preserve the user configured priority order",
  );

  router.recordUsage(
    "zero-token-history",
    "gpt-5.6-sol",
    { input: 0, output: 0, cached: 0 },
    { source: "external", success: false, errorCategory: "upstream" },
  );
  const zeroTokenHistory = router.usage()["zero-token-history"];
  assert.strictEqual(
    zeroTokenHistory.requests.length,
    1,
    "failed attempts without usage must remain visible in the safe request history",
  );
  assert.strictEqual(zeroTokenHistory.requests[0].errorCategory, "upstream");
  assert.strictEqual(
    zeroTokenHistory.recent.calls,
    0,
    "zero-token failures must not affect cache-rate calculations",
  );
  assert.strictEqual(zeroTokenHistory.recent.hitRate, 0);

  router.recordUsage(
    "anthropic-cache-accounting",
    "claude-opus-5",
    { input: 0, output: 1, cached: 100, cacheWrite: 50, usageObserved: true },
    { source: "external", success: true },
  );
  const anthropicCacheAccounting = router.usage()["anthropic-cache-accounting"];
  assert.strictEqual(
    anthropicCacheAccounting.recent.calls,
    1,
    "requests with cache reads or writes are valid cache-rate samples even when regular input is zero",
  );
  assert.strictEqual(
    anthropicCacheAccounting.hitRate,
    66.7,
    "Anthropic cache writes must be included in the cache-rate denominator",
  );
  assert.strictEqual(anthropicCacheAccounting.recent.hitRate, 66.7);
  assert.strictEqual(anthropicCacheAccounting.requests[0].hitRate, 66.7);

  const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dao-request-history-"));
  const historyConfigPath = path.join(historyDir, "config.json");
  fs.copyFileSync(integrationConfigPath, historyConfigPath);
  fs.writeFileSync(
    path.join(historyDir, ".dao-request-history.json"),
    JSON.stringify({
      version: 1,
      samples: [
        {
          at: Date.now(),
          provider: "persisted-history",
          model: "gpt-5.6-sol",
          source: "cascade",
          input: 123,
          output: 4,
          cached: 100,
          success: true,
          usageObserved: true,
        },
      ],
    }),
    "utf8",
  );
  router.init({ configPath: historyConfigPath, log: () => {} });
  const persistedHistory = router.usage()["persisted-history"];
  assert.strictEqual(
    persistedHistory.requests.length,
    1,
    "a safe recent-request sample must survive a runtime restart",
  );
  assert.strictEqual(persistedHistory.requests[0].input, 123);
  assert.strictEqual(
    persistedHistory.calls,
    1,
    "safe request history must also restore the dashboard's read-only aggregate after restart",
  );
  assert.strictEqual(persistedHistory.hitRate, 81.3);
  assert.strictEqual(
    persistedHistory.recent.calls,
    0,
    "historical samples must not be reported as this process's cache window",
  );
  for (let index = 0; index < 3; index += 1) {
    router.recordUsage(
      "keep-ay",
      "gpt-5.6-terra",
      { input: 1000, output: 10, cached: 700, usageObserved: true },
      { source: "cascade" },
    );
  }
  for (let index = 0; index < 60; index += 1) {
    router.recordUsage(
      "flood-glm",
      "glm-5.3",
      { input: 800, output: 8, cached: 790, usageObserved: true },
      { source: "cascade" },
    );
  }
  const keptAy = router.usage()["keep-ay"];
  assert.ok(keptAy, "ay/terra samples must survive a later glm flood");
  assert.strictEqual(
    keptAy.requests.length,
    3,
    "per-provider request history must not be evicted by another channel",
  );
  assert.strictEqual(keptAy.requests[0].model, "gpt-5.6-terra");
  assert.ok(
    keptAy.requests.every((sample) => sample.cached === 700),
    "retained ay/terra rows must keep their observed cache reads",
  );
  const floodedGlm = router.usage()["flood-glm"];
  assert.ok(floodedGlm.requests.length <= 40);
  assert.ok(floodedGlm.requests.length >= 1);

  router.recordUsage(
    "written-history",
    "gpt-5.6-sol",
    { input: 8, output: 2, cached: 4 },
    { source: "cascade", prompt: "must-not-persist" },
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const persistedFile = fs.readFileSync(
    path.join(historyDir, ".dao-request-history.json"),
    "utf8",
  );
  assert(persistedFile.includes('"written-history"'));
  assert(!persistedFile.includes("must-not-persist"));

  await Promise.all([
    new Promise((resolve) => primaryServer.close(resolve)),
    new Promise((resolve) => siblingServer.close(resolve)),
  ]);
}

runRouteFailoverTest()
  .then(() => {
    console.log("cache resilience tests passed");
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

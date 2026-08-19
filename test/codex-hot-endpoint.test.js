"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const router = require("../vendor/外接api/core/dao_router.js");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dao-codex-endpoint-"));
process.env.USERPROFILE = temp;
process.env.HOME = temp;
fs.mkdirSync(path.join(temp, ".codex"), { recursive: true });
const nativeCatalog = {
  models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        description: "Native Codex model metadata fixture",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "medium", description: "Balanced reasoning" },
          { effort: "high", description: "Deeper reasoning" },
        ],
        shell_type: "shell_command",
        // Cockpit often ships code_mode_only; hot route must still expose classic tools.
        tool_mode: "code_mode_only",
        use_responses_lite: true,
        visibility: "list",
        supported_in_api: true,
        priority: 2,
        availability_nux: null,
        upgrade: null,
        base_instructions: "native codex instructions",
        default_reasoning_summary: "none",
        support_verbosity: true,
        default_verbosity: "low",
        apply_patch_tool_type: "freeform",
        truncation_policy: { mode: "tokens", limit: 10000 },
        supports_parallel_tool_calls: true,
        experimental_supported_tools: [],
      },
    ],
};
fs.writeFileSync(
  path.join(temp, ".codex", "models_cache.json"),
  JSON.stringify(nativeCatalog),
  "utf8",
);
const daoCatalog = JSON.parse(JSON.stringify(nativeCatalog));
daoCatalog.models[0].tool_mode = "direct";
daoCatalog.models[0].use_responses_lite = false;
fs.writeFileSync(
  path.join(temp, ".codex", "dao-codex-model-catalog.json"),
  JSON.stringify(daoCatalog),
  "utf8",
);
fs.writeFileSync(
  path.join(temp, ".codex", "config.toml"),
  'model_catalog_json = "dao-codex-model-catalog.json"\n',
  "utf8",
);

const revproxy = require("../vendor/外接api/core/revproxy");
const sourceText = fs.readFileSync(
  path.join(__dirname, "..", "vendor", "bundled-origin", "source.js"),
  "utf8",
);
assert.strictEqual(
  (sourceText.match(/req\.url\.startsWith\("\/codex-hot\/v1\/"\)/g) || []).length,
  2,
  "both the outer server dispatcher and inner reverse-proxy gate must accept Codex hot paths",
);
assert.match(sourceText, /body\.action === "disable"/);
assert.match(sourceText, /codexMod\.disable/);
assert.match(sourceText, /codexMod\.apply/);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

(async () => {
  let upstreamBody = null;
  let upstreamPath = "";
  const upstreamCalls = new Map();
  const recordedUsage = [];
  const observedCodex = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamPath = req.url;
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (req.url === "/v1/responses/compact") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "cmp_test",
          object: "response.compaction",
          created_at: 1,
          output: [{ type: "compaction", encrypted_content: "opaque-state" }],
          usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
        }));
        return;
      }
      const requestText = JSON.stringify(upstreamBody);
      const behavior = requestText.includes("reasoning-only-retry")
        ? "reasoning-only-retry"
        : requestText.includes("reasoning-only-fail")
          ? "reasoning-only-fail"
          : requestText.includes("tool-only")
            ? "tool-only"
          : requestText.includes("fallback-empty")
            ? "fallback-empty"
            : "normal";
      const provider = req.headers.authorization === "Bearer backup-secret" ? "backup" : "primary";
      const callKey = provider + ":" + behavior;
      upstreamCalls.set(callKey, (upstreamCalls.get(callKey) || 0) + 1);
      if (behavior === "fallback-empty" && provider === "primary") {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "primary upstream failed" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (behavior === "reasoning-only-retry" || behavior === "reasoning-only-fail") {
        res.write('data: {"type":"response.reasoning_summary_text.delta","delta":"hidden reasoning"}\n\n');
      }
      if (behavior === "normal") {
        res.write('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
      } else if (behavior === "tool-only") {
        res.write('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_test","call_id":"call_test","name":"read_file"}}\n\n');
        res.write('data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_test","call_id":"call_test","name":"read_file","arguments":"{}"}}\n\n');
      } else if (behavior === "reasoning-only-retry" && upstreamCalls.get(callKey) === 2) {
        res.write('data: {"type":"response.output_text.delta","delta":"recovered"}\n\n');
      } else if (behavior === "fallback-empty" && provider === "backup") {
        res.write('data: {"type":"response.output_text.delta","delta":"backup-ok"}\n\n');
      }
      res.write('data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":1}}}\n\n');
      res.end();
    });
  });
  const upstreamPort = await listen(upstream);

  assert(revproxy.saveConfig({
    ...revproxy.defaultConfig(),
    enabled: true,
    apiKey: "local-secret",
    disabledModels: ["gpt-5.6-sol"],
  }));

  const providers = {
    kfcoding: {
      apiKey: "upstream-secret",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      protocol: "openai-responses",
      models: ["gpt-5.6-sol"],
    },
    xai: {
      apiKey: "wrong-secret",
      baseUrl: "http://127.0.0.1:1/v1",
      protocol: "openai-responses",
      models: ["gpt-5.6-sol"],
    },
    backup: {
      apiKey: "backup-secret",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      protocol: "openai-responses",
      models: ["fallback-model"],
    },
  };
  const hot = {
    enabled: true,
    provider: "kfcoding",
    model: "gpt-5.6-sol",
    protocol: "openai-responses",
    reasoningLevel: "high",
  };

  const proxy = http.createServer((req, res) => {
    revproxy.handle(req, res, new URL(req.url, "http://127.0.0.1"), {
      port: proxy.address().port,
      getCodexHotRoute: () => hot,
      getEaConfig: () => ({
        providers,
        daoRoutes: {
          routes: {
            "gpt-5.6-sol": {
              provider: "xai",
              model: "gpt-5.6-sol",
              protocol: "openai-responses",
            },
            "fallback-model": {
              provider: "kfcoding",
              model: "fallback-model",
              protocol: "openai-responses",
              autoFallback: true,
              channelPriority: [
                { provider: "kfcoding", model: "fallback-model", protocol: "openai-responses" },
                { provider: "backup", model: "fallback-model", protocol: "openai-responses" },
              ],
            },
          },
        },
      }),
      getModelCatalog: () => [],
      getOfficialFamilies: () => [],
      getProxyAgent: () => null,
      recordUsage(provider, model, usage, observation) {
        recordedUsage.push({ provider, model, usage, observation });
      },
      markCodexObserved(value) {
        observedCodex.push(value);
      },
      log: () => {},
    }).catch((error) => {
      res.statusCode = 500;
      res.end(String(error && error.message));
    });
  });
  const proxyPort = await listen(proxy);

  const catalogResponse = await fetch(
    `http://127.0.0.1:${proxyPort}/codex-hot/v1/models`,
    { headers: { authorization: "Bearer local-secret" } },
  );
  const catalog = await catalogResponse.json();
  assert.strictEqual(catalogResponse.status, 200);
  assert(Array.isArray(catalog.models));
  assert.strictEqual(catalog.models[0].slug, "gpt-5.6-sol");
  assert.strictEqual(catalog.models[0].default_reasoning_level, "high");
  assert.strictEqual(catalog.models[0].base_instructions, "native codex instructions");
  // Regression: local/dao hot route must not leave Codex on code_mode_only with no host
  // (that yields zero classic tools: no shell / apply_patch).
  assert.strictEqual(catalog.models[0].tool_mode, "direct");
  assert.strictEqual(catalog.models[0].use_responses_lite, false);
  assert.strictEqual(catalog.models[0].shell_type, "shell_command");
  assert.strictEqual(catalog.models[0].apply_patch_tool_type, "freeform");
  assert.strictEqual("data" in catalog, false);

  const standardCatalogResponse = await fetch(
    `http://127.0.0.1:${proxyPort}/v1/models`,
    { headers: { authorization: "Bearer local-secret" } },
  );
  const standardCatalog = await standardCatalogResponse.json();
  assert.strictEqual(standardCatalogResponse.status, 200);
  assert(Array.isArray(standardCatalog.data));
  assert.strictEqual("models" in standardCatalog, false);

  const response = await fetch(`http://127.0.0.1:${proxyPort}/codex-hot/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer local-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "test",
      stream: false,
      prompt_cache_key: "codex-thread-private",
      reasoning: { effort: "medium" },
    }),
  });
  const body = await response.json();
  assert.strictEqual(response.status, 200);
  assert.strictEqual(body.output[0].content[0].text, "ok");
  assert.strictEqual(upstreamPath, "/v1/responses");
  assert.strictEqual(upstreamBody.model, "gpt-5.6-sol");
  assert.strictEqual(upstreamBody.reasoning.effort, "high");
  assert.strictEqual(upstreamBody.store, false);
  assert.strictEqual(recordedUsage.length, 1);
  assert.strictEqual(recordedUsage[0].provider, "kfcoding");
  assert.strictEqual(recordedUsage[0].observation.source, "codex");
  assert.match(recordedUsage[0].observation.cacheKeyHash, /^[a-f0-9]{8}$/);
  assert(recordedUsage[0].observation.durationMs >= 0);
  assert(recordedUsage[0].observation.ttftMs >= 0);
  assert.strictEqual(recordedUsage[0].observation.responseToolCount, 0);
  assert.strictEqual(recordedUsage[0].observation.success, true);
  assert.strictEqual(recordedUsage[0].observation.usageObserved, true);
  assert.strictEqual(recordedUsage[0].observation.firstSignalKind, "text");
  assert.strictEqual(recordedUsage[0].observation.ttftObserved, true);
  assert(recordedUsage[0].observation.daoDispatchMs >= 0);
  assert.strictEqual(typeof recordedUsage[0].observation.upstreamHeaderMs, "number");
  assert(recordedUsage[0].observation.upstreamHeaderMs >= 0);
  assert.strictEqual(typeof recordedUsage[0].observation.upstreamSemanticMs, "number");
  assert(
    recordedUsage[0].observation.upstreamSemanticMs >=
      recordedUsage[0].observation.upstreamHeaderMs,
  );
  assert(recordedUsage[0].observation.retryOverheadMs >= 0);
  assert(!JSON.stringify(recordedUsage).includes("codex-thread-private"));
  assert.strictEqual(observedCodex.length, 1);

  recordedUsage.length = 0;
  const toolResponse = await fetch(`http://127.0.0.1:${proxyPort}/codex-hot/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "tool-only",
      stream: false,
      tools: [{
        type: "function",
        name: "read_file",
        description: "Read a workspace file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      }],
      tool_choice: "required",
    }),
  });
  const toolBody = await toolResponse.json();
  assert.strictEqual(toolResponse.status, 200);
  assert.strictEqual(toolBody.output[0].type, "function_call");
  assert.strictEqual(upstreamPath, "/v1/responses");
  assert.deepStrictEqual(upstreamBody.tools, [{
    type: "function",
    name: "read_file",
    description: "Read a workspace file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  }]);
  assert.strictEqual(upstreamBody.tool_choice, "required");
  assert.strictEqual(recordedUsage.length, 1);
  assert.strictEqual(recordedUsage[0].observation.firstSignalKind, "tool");
  assert.strictEqual(recordedUsage[0].observation.ttftObserved, true);
  assert(recordedUsage[0].observation.responseToolCount >= 1);

  const retryResponse = await fetch(`http://127.0.0.1:${proxyPort}/codex-hot/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "reasoning-only-retry", stream: false }),
  });
  const retryBody = await retryResponse.json();
  assert.strictEqual(retryResponse.status, 200);
  assert.strictEqual(retryBody.output_text, "recovered");
  assert.strictEqual(upstreamCalls.get("primary:reasoning-only-retry"), 2);
  assert.strictEqual(
    observedCodex.length,
    1,
    "a successful manual probe without a Codex cache key must not acknowledge restart",
  );

  upstreamCalls.delete("primary:reasoning-only-retry");
  recordedUsage.length = 0;
  observedCodex.length = 0;
  const retryStreamResponse = await fetch(
    `http://127.0.0.1:${proxyPort}/codex-hot/v1/responses`,
    {
      method: "POST",
      signal: AbortSignal.timeout(3000),
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: "reasoning-only-retry",
        stream: true,
        prompt_cache_key: "codex-thread-private",
      }),
    },
  );
  const retryStreamBody = await retryStreamResponse.text();
  assert.strictEqual(retryStreamResponse.status, 200);
  assert.match(retryStreamBody, /response\.output_text\.delta/);
  assert.match(retryStreamBody, /recovered/);
  assert.match(retryStreamBody, /response\.completed/);
  assert.strictEqual(
    (retryStreamBody.match(/event: response\.reasoning_summary_text\.delta/g) || []).length,
    1,
    "reasoning from the discarded empty attempt must not leak downstream",
  );
  assert.strictEqual(upstreamCalls.get("primary:reasoning-only-retry"), 2);
  assert.strictEqual(recordedUsage.length, 1, "transparent retry records committed usage once");
  assert.strictEqual(recordedUsage[0].observation.attemptCount, 2);
  const retryAttempts = recordedUsage[0].observation.attempts;
  assert.strictEqual(retryAttempts.length, 2);
  assert.notStrictEqual(retryAttempts[0].attemptId, retryAttempts[1].attemptId);
  assert.strictEqual(retryAttempts[0].attemptIndex, 1);
  assert.strictEqual(retryAttempts[1].attemptIndex, 2);
  assert.strictEqual(retryAttempts[0].outcome, "discarded");
  assert.strictEqual(retryAttempts[1].outcome, "committed");
  assert.strictEqual(retryAttempts[0].retryReason, "empty-response");
  assert.strictEqual(retryAttempts[1].retryReason, "empty-response");
  assert.strictEqual(retryAttempts[1].usageObserved, true);
  assert.strictEqual(
    recordedUsage[0].observation.committedAttemptId,
    retryAttempts[1].attemptId,
  );
  assert(retryAttempts[0].startedAt > 0);
  assert(retryAttempts[0].endedAt >= retryAttempts[0].startedAt);
  assert(retryAttempts[1].startedAt > 0);
  assert(retryAttempts[1].endedAt >= retryAttempts[1].startedAt);
  assert.strictEqual(recordedUsage[0].observation.firstSignalKind, "text");
  assert.strictEqual(recordedUsage[0].observation.ttftObserved, true);
  assert(recordedUsage[0].observation.retryOverheadMs >= 0);
  assert.strictEqual(observedCodex.length, 1, "a committed Codex request clears restart-required once");

  const emptyResponse = await fetch(`http://127.0.0.1:${proxyPort}/codex-hot/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "reasoning-only-fail", stream: false }),
  });
  const emptyBody = await emptyResponse.json();
  assert.strictEqual(emptyResponse.status, 502);
  assert.match(emptyBody.error.message, /no visible text or tool calls/i);
  assert.strictEqual(upstreamCalls.get("primary:reasoning-only-fail"), 2);

  upstreamCalls.delete("primary:reasoning-only-fail");
  recordedUsage.length = 0;
  observedCodex.length = 0;
  const emptyStreamResponse = await fetch(
    `http://127.0.0.1:${proxyPort}/codex-hot/v1/responses`,
    {
      method: "POST",
      signal: AbortSignal.timeout(3000),
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "reasoning-only-fail", stream: true }),
    },
  );
  const emptyStreamBody = await emptyStreamResponse.text();
  assert.strictEqual(emptyStreamResponse.status, 200);
  assert.match(emptyStreamBody, /event: error/);
  assert.match(emptyStreamBody, /no visible text or tool calls/i);
  assert.doesNotMatch(emptyStreamBody, /response\.completed/);
  assert.doesNotMatch(emptyStreamBody, /hidden reasoning/);
  assert.strictEqual(upstreamCalls.get("primary:reasoning-only-fail"), 2);
  assert.strictEqual(recordedUsage.length, 1, "terminal failure records one request sample");
  assert.strictEqual(recordedUsage[0].observation.success, false);
  assert.strictEqual(recordedUsage[0].observation.usageObserved, false);
  assert.strictEqual(recordedUsage[0].observation.errorCategory, "upstream");
  assert.strictEqual(recordedUsage[0].observation.firstSignalKind, "none");
  assert.strictEqual(recordedUsage[0].observation.ttftObserved, false);
  assert.strictEqual(recordedUsage[0].observation.ttftMs, null);
  const failedAttempts = recordedUsage[0].observation.attempts;
  assert.strictEqual(failedAttempts.length, 2);
  assert.deepStrictEqual(failedAttempts.map((attempt) => attempt.outcome), ["discarded", "failed"]);
  assert.strictEqual(failedAttempts[0].usageObserved, true);
  assert.strictEqual(failedAttempts[1].usageObserved, true);
  assert(failedAttempts[0].startedAt > 0);
  assert(failedAttempts[0].endedAt >= failedAttempts[0].startedAt);
  assert(failedAttempts[1].startedAt > 0);
  assert(failedAttempts[1].endedAt >= failedAttempts[1].startedAt);
  assert.strictEqual(observedCodex.length, 0, "failed requests do not clear restart-required");

  recordedUsage.length = 0;
  const fallbackResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "fallback-model", input: "fallback-empty", stream: false }),
  });
  const fallbackBody = await fallbackResponse.json();
  assert.strictEqual(fallbackResponse.status, 200);
  assert.strictEqual(fallbackBody.output_text, "backup-ok");
  assert.strictEqual(upstreamCalls.get("primary:fallback-empty"), 1);
  assert.strictEqual(upstreamCalls.get("backup:fallback-empty"), 1);
  assert.strictEqual(recordedUsage.length, 1, "fallback records committed usage once");
  const fallbackAttempts = recordedUsage[0].observation.attempts;
  assert.strictEqual(fallbackAttempts.length, 2);
  assert.deepStrictEqual(fallbackAttempts.map((attempt) => attempt.outcome), ["failed", "committed"]);
  assert.strictEqual(fallbackAttempts[0].status, 502);
  assert.strictEqual(fallbackAttempts[0].errorCategory, "upstream");
  assert.strictEqual(fallbackAttempts[0].usageObserved, false);
  assert.strictEqual(fallbackAttempts[1].usageObserved, true);
  assert.strictEqual(fallbackAttempts[1].retryReason, "upstream-error");
  assert.strictEqual(
    recordedUsage[0].observation.committedAttemptId,
    fallbackAttempts[1].attemptId,
  );

  const aggregateProvider = recordedUsage[0].provider;
  const beforeAggregate = router.usage()[aggregateProvider] || {
    calls: 0,
    input: 0,
    output: 0,
    cached: 0,
  };
  router.recordUsage(
    aggregateProvider,
    recordedUsage[0].model,
    recordedUsage[0].usage,
    recordedUsage[0].observation,
  );
  const afterAggregate = router.usage()[aggregateProvider];
  assert.strictEqual(afterAggregate.calls - beforeAggregate.calls, 1);
  assert.strictEqual(afterAggregate.input - beforeAggregate.input, recordedUsage[0].usage.input);
  assert.strictEqual(afterAggregate.output - beforeAggregate.output, recordedUsage[0].usage.output);
  assert.strictEqual(afterAggregate.cached - beforeAggregate.cached, recordedUsage[0].usage.cached || 0);
  const aggregateSample = afterAggregate.requests.at(-1);
  assert.strictEqual(aggregateSample.attempts.length, 2);
  assert.deepStrictEqual(
    aggregateSample.attempts.map((attempt) => attempt.outcome),
    ["failed", "committed"],
  );
  assert(!JSON.stringify(aggregateSample).includes("requestId"));
  assert(!JSON.stringify(aggregateSample).includes("attemptId"));

  const compactResponse = await fetch(`http://127.0.0.1:${proxyPort}/codex-hot/v1/responses/compact`, {
    method: "POST",
    headers: {
      authorization: "Bearer local-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "dao-codex-hot",
      input: [{ role: "user", content: "compact this history" }],
      instructions: "Keep the task state.",
      prompt_cache_key: "stable-cascade-key",
      tools: [{ type: "function", name: "must-not-forward" }],
      reasoning: { effort: "high" },
    }),
  });
  const compactBody = await compactResponse.json();
  assert.strictEqual(compactResponse.status, 200);
  assert.strictEqual(compactBody.output[0].encrypted_content, "opaque-state");
  assert.strictEqual(upstreamPath, "/v1/responses/compact");
  assert.strictEqual(upstreamBody.model, "gpt-5.6-sol");
  assert.strictEqual(upstreamBody.prompt_cache_key, "stable-cascade-key");
  assert.strictEqual("tools" in upstreamBody, false);
  assert.strictEqual("reasoning" in upstreamBody, false);

  await close(proxy);
  await close(upstream);
  fs.rmSync(temp, { recursive: true, force: true });
  console.log("codex hot endpoint selftest: PASS");
})().catch((error) => {
  fs.rmSync(temp, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});

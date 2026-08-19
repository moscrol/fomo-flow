"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-prompt-cache-router-"));
process.env.HOME = tempHome;
const router = require("../vendor/外接api/core/dao_router.js");
let activeServer = null;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function responseSink() {
  return {
    headersSent: false,
    writableEnded: false,
    chunks: [],
    writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
    },
  };
}

(async function main() {
  const requestBodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requestBodies.push(body);
      if (!req.url.startsWith("/warm/") && body.prompt_cache_options) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: { message: 'Unknown parameter: "prompt_cache_options"' },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 2_000,
          completion_tokens: 1,
          prompt_tokens_details: {
            cached_tokens: 1_500,
            cache_write_tokens: 500,
          },
        },
      })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  activeServer = server;
  await listen(server);
  const configPath = path.join(tempHome, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    providers: {
      cache: {
        enabled: true,
        type: "openai-compatible",
        protocol: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        completionPath: "/v1/chat/completions",
        streamMode: "stream",
        models: ["gpt-5.6-terra"],
        promptCache: {
          enabled: true,
          openaiMode: "explicit",
          openaiTtl: "30m",
          warmup: { enabled: false },
        },
      },
    },
    daoRoutes: {
      enabled: true,
      agentStatus: { enabled: true, defaultMode: "on" },
      routes: {
        MODEL_CACHE: { provider: "cache", model: "gpt-5.6-terra" },
      },
    },
  }), "utf8");
  router.init({ configPath, log: () => {} });

  const response = responseSink();
  const rawBody = Buffer.from(JSON.stringify({
    modelUid: "MODEL_CACHE",
    prompt: "S".repeat(5_000),
    messages: [{ role: "user", content: "inspect the cache policy" }],
    cascadeId: "cache-policy-session",
  }));
  assert.strictEqual(
    await router.route({}, response, rawBody, true, "MODEL_CACHE"),
    true,
  );
  assert.strictEqual(requestBodies.length, 2, "unsupported explicit hints retry once");
  const explicitBody = requestBodies[0];
  const fallbackBody = requestBodies[1];
  assert.strictEqual(explicitBody.prompt_cache_key, "dao:cache-policy-session");
  assert.deepStrictEqual(explicitBody.prompt_cache_options, {
    mode: "explicit",
    ttl: "30m",
  });
  const explicitMessages = explicitBody.messages || [];
  const statusMessage = explicitMessages.find((message) =>
    JSON.stringify(message.content).includes("<!--dao-agent-status-->"));
  const stableMessage = explicitMessages.find((message) =>
    JSON.stringify(message.content).includes("inspect the cache policy"));
  assert.ok(statusMessage, "Agent HUD remains in the request suffix");
  assert.ok(stableMessage, "stable user request remains present");
  assert.doesNotMatch(JSON.stringify(statusMessage), /prompt_cache_breakpoint/);
  assert.match(JSON.stringify(stableMessage), /prompt_cache_breakpoint/);
  assert.strictEqual(fallbackBody.prompt_cache_key, "dao:cache-policy-session");
  assert.strictEqual(fallbackBody.prompt_cache_options, undefined);
  assert.doesNotMatch(JSON.stringify(fallbackBody.messages), /prompt_cache_breakpoint/);

  const usage = router.usage().cache;
  assert.strictEqual(usage.cached, 1_500);
  assert.strictEqual(usage.cacheWrite, 500);
  const sample = usage.requests.at(-1);
  assert.strictEqual(sample.cacheMode, "implicit");
  assert.strictEqual(sample.cacheDowngrade, "openai-explicit");
  assert.strictEqual(sample.volatileSuffixCount, 1);
  assert.match(sample.stablePrefixHash, /^[a-f0-9]{12}$/);
  assert.ok(sample.stablePrefixChars > 0);
  assert.doesNotMatch(
    JSON.stringify(sample),
    /cache-policy-session|inspect the cache policy|<!--dao-agent-status-->/,
  );

  // Let the first init's fs.watch debounce settle before installing a second
  // in-process config; otherwise it can dispose the warmup timer under test.
  await new Promise((resolve) => setTimeout(resolve, 650));

  const warmConfigPath = path.join(tempHome, "warm-config.json");
  fs.writeFileSync(warmConfigPath, JSON.stringify({
    providers: {
      warm: {
        enabled: true,
        type: "openai-compatible",
        protocol: "openai-chat",
        baseUrl: `http://127.0.0.1:${server.address().port}/warm`,
        completionPath: "/v1/chat/completions",
        streamMode: "stream",
        models: ["gpt-5.6-terra"],
        promptCache: {
          enabled: true,
          openaiMode: "explicit",
          warmup: {
            enabled: true,
            afterMs: 1_000,
            minStableTokens: 1,
            maxPerHour: 1,
          },
        },
      },
    },
    daoRoutes: {
      enabled: true,
      agentStatus: { enabled: true, defaultMode: "on" },
      routes: {
        MODEL_WARM: { provider: "warm", model: "gpt-5.6-terra" },
      },
    },
  }), "utf8");
  router.init({ configPath: warmConfigPath, log: () => {} });
  const beforeWarm = requestBodies.length;
  assert.strictEqual(
    await router.route({}, responseSink(), Buffer.from(JSON.stringify({
      modelUid: "MODEL_WARM",
      prompt: "W".repeat(5_000),
      messages: [{ role: "user", content: "warm this stable prefix" }],
      tools: [{
        name: "read_file",
        description: "Read a file.",
        json_schema_string: JSON.stringify({
          type: "object",
          properties: {},
        }),
      }],
      cascadeId: "warm-session",
    })), true, "MODEL_WARM"),
    true,
  );
  assert.strictEqual(requestBodies.length, beforeWarm + 1);
  const liveWarmBody = requestBodies.at(-1);
  assert.deepStrictEqual(liveWarmBody.prompt_cache_options, {
    mode: "explicit",
    ttl: "30m",
  });
  assert.match(JSON.stringify(liveWarmBody.messages), /prompt_cache_breakpoint/);
  assert.strictEqual(
    router._test.promptCachePolicyStatus().activeWarmups,
    1,
    JSON.stringify(router.usage().warm && router.usage().warm.requests.at(-1)),
  );
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  const warmStatus = router._test.promptCachePolicyStatus();
  assert.strictEqual(
    requestBodies.length,
    beforeWarm + 2,
    `one bounded warmup fires: ${JSON.stringify(warmStatus)}`,
  );
  const warmupBody = requestBodies.at(-1);
  assert.strictEqual(warmupBody.max_tokens, 1);
  assert.strictEqual(warmupBody.tool_choice, "none");
  assert.strictEqual(warmupBody.stream, false);
  assert.doesNotMatch(JSON.stringify(warmupBody.messages), /<!--dao-agent-status-->/);
  assert.strictEqual(warmStatus.warmupSent, 1);

  router.recordUsage("privacy", "test", { input: 1 }, {
    agentSessionHash: "RAW_AGENT_KEY",
    sessionHash: "dao:raw-session-key",
    cacheKeyHash: "RAW_CACHE_KEY",
  });
  const privacySample = router._test.cacheSamples().at(-1);
  assert.strictEqual(privacySample.agentSessionHash, null);
  assert.strictEqual(privacySample.sessionHash, null);
  assert.strictEqual(privacySample.cacheKeyHash, null);

  await new Promise((resolve) => server.close(resolve));
  activeServer = null;
  fs.rmSync(tempHome, { recursive: true, force: true });
  console.log("prompt cache router: PASS");
})().catch(async (error) => {
  console.error(error);
  if (activeServer) {
    await new Promise((resolve) => activeServer.close(resolve));
    activeServer = null;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
  process.exitCode = 1;
});

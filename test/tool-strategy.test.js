"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const outputStore = require("../vendor/外接api/core/tool_output_store");
const toolStrategy = require("../vendor/外接api/core/tool_strategy");
const adapters = require("../vendor/外接api/core/adapters");
const router = require("../vendor/外接api/core/dao_router");

assert.strictEqual(
  adapters.OpenAIResponsesAdapter.getCompletionPath({
    completionPath: "/v1/chat/completions",
  }),
  "/v1/responses",
  "Responses requests must not reuse a Chat Completions path",
);
assert.strictEqual(
  adapters.OpenAIChatAdapter.getCompletionPath({ completionPath: "/v1/responses" }),
  "/v1/chat/completions",
  "Chat requests must not reuse a Responses path",
);
assert.strictEqual(
  adapters.OpenAIResponsesAdapter.getCompletionPath({
    completionPath: "/custom/inference",
  }),
  "/custom/inference",
  "unknown custom completion paths must remain supported",
);

assert.strictEqual(
  router._test.resolveTargetProtocol(
    { sourceProtocol: "openai-responses" },
    { protocol: "openai-chat" },
    "gpt-5.6-sol",
  ),
  "openai-responses",
  "an explicit custom-model Responses protocol must override the channel default",
);
assert.strictEqual(
  router._test.requestReasoningSettings(
    {
      _customModel: true,
      thinkingEnabled: true,
      reasoningEffort: "high",
    },
    "openai-responses",
    "gpt-5.6-sol",
    true,
  ).reasoningEffort,
  "high",
  "Responses reasoning effort must not be disabled by the Chat+tools compatibility rule",
);
assert.strictEqual(
  router._test.resolveTargetProtocol(
    { reasoningLevel: "high", thinkingEnabled: false },
    { protocol: "openai-chat" },
    "gpt-5.6-sol",
  ),
  "openai-responses",
  "a quality route mapped to gpt-5.6-sol must override the provider Chat default",
);
assert.deepStrictEqual(
  router._test.requestReasoningSettings(
    { reasoningLevel: "high", thinkingEnabled: false },
    "openai-responses",
    "gpt-5.6-sol",
    true,
  ),
  {
    thinkingEnabled: true,
    thinkingBudget: null,
    reasoningEffort: "high",
    adjusted: false,
  },
  "the explicit route reasoning level must override stale thinking flags",
);
const legacyThinkingRoute = router._test.normalizeQualityRoute(
  "claude-opus-4-6-thinking",
  { model: "gpt-5.6-sol", thinkingEnabled: false },
);
assert.strictEqual(legacyThinkingRoute.protocol, "openai-responses");
assert.strictEqual(legacyThinkingRoute.reasoningLevel, "high");
assert.strictEqual(legacyThinkingRoute.reasoningEffort, "high");
assert.strictEqual(legacyThinkingRoute.thinkingEnabled, true);
assert.strictEqual(
  router._test.usesPersistedToolOutputs(
    { sourceProtocol: "openai-responses" },
    { protocol: "openai-chat" },
    "gpt-5.6-sol",
  ),
  false,
  "Responses routes must preserve Devin's transcript by default",
);
assert.strictEqual(
  router._test.usesPersistedToolOutputs(
    {
      sourceProtocol: "openai-responses",
      contextStrategy: { persistToolOutputs: false },
    },
    { protocol: "openai-chat" },
    "gpt-5.6-sol",
  ),
  false,
  "persistToolOutputs:false must disable the default Responses policy",
);
assert.strictEqual(
  router._test.usesPersistedToolOutputs(
    { contextStrategy: { persistToolOutputs: true } },
    { protocol: "openai-chat" },
    "legacy-chat-model",
  ),
  true,
  "explicit persistence must remain compatible with legacy proxy-managed routes",
);

const responsesMultimodalBody = adapters.OpenAIResponsesAdapter.buildRequest({
  model: "gpt-5.6-sol",
  system: "You are a coding agent.",
  messages: [
    { role: "system", content: "You are a coding agent." },
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect this screenshot." },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AA==", detail: "high" },
        },
      ],
    },
  ],
  stream: true,
  thinkingEnabled: true,
  reasoningEffort: "high",
});
assert.strictEqual(responsesMultimodalBody.instructions, "You are a coding agent.");
assert.strictEqual(responsesMultimodalBody.store, false);
assert.deepStrictEqual(responsesMultimodalBody.include, [
  "reasoning.encrypted_content",
]);
assert.deepStrictEqual(responsesMultimodalBody.reasoning, {
  summary: "auto",
  effort: "high",
});
assert.strictEqual(
  responsesMultimodalBody.input.some((item) => item.role === "system"),
  false,
  "Responses system instructions must not be duplicated in input",
);
assert.deepStrictEqual(responsesMultimodalBody.input[0].content, [
  { type: "input_text", text: "Inspect this screenshot." },
  {
    type: "input_image",
    image_url: "data:image/png;base64,AA==",
    detail: "high",
  },
]);

const continuationKey = "provider|gpt-5.6-sol|cascade-1";
assert.strictEqual(
  adapters.OpenAIResponsesAdapter.commitContinuation(continuationKey, [
    {
      id: "reasoning-1",
      type: "reasoning",
      encrypted_content: "opaque-reasoning",
      summary: [],
    },
    {
      id: "function-1",
      type: "function_call",
      call_id: "call-1",
      name: "Read",
      arguments: '{"path":"README.md"}',
    },
  ]),
  true,
);
const continuationBody = adapters.OpenAIResponsesAdapter.buildRequest({
  model: "gpt-5.6-sol",
  continuationKey,
  promptCacheKey: "cascade-1",
  messages: [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          function: { name: "Read", arguments: '{"path":"README.md"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: "file contents" },
  ],
  stream: true,
  reasoningEffort: "high",
});
const reasoningIndex = continuationBody.input.findIndex(
  (item) => item.type === "reasoning" && item.id === "reasoning-1",
);
const callIndex = continuationBody.input.findIndex(
  (item) => item.type === "function_call" && item.call_id === "call-1",
);
assert.strictEqual(reasoningIndex + 1, callIndex);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dao-tool-strategy-"));
outputStore.init({ dir: path.join(tempDir, "outputs"), log: () => {} });

const fullOutput = `Exit code: 0\nOutput:\n${"large-result-line\n".repeat(1800)}`;
const compacted = outputStore.compactMessages([
  { role: "tool", tool_call_id: "large-call", content: fullOutput },
], { preserveRecentToolResults: 0 });
assert.strictEqual(compacted.compacted, 1);
assert.ok(compacted.savedChars > 20000);
const outputId = compacted.messages[0].content.match(/dao-output:\/\/([a-f0-9]{32})/)[1];
const firstChunk = outputStore.read(outputId, 0, 12000);
const secondChunk = outputStore.read(outputId, firstChunk.nextOffset, 24000);
assert.strictEqual(firstChunk.ok, true);
assert.strictEqual(firstChunk.hasMore, true);
assert.strictEqual(
  firstChunk.content + secondChunk.content,
  fullOutput.slice(0, firstChunk.content.length + secondChunk.content.length),
);
assert.strictEqual(
  outputStore.compactMessages([
    { role: "tool", tool_call_id: "large-call", content: fullOutput },
  ], { preserveRecentToolResults: 0 }).messages[0].content,
  compacted.messages[0].content,
  "same output must keep a deterministic reference for prompt caching",
);

const recentWindowMessages = Array.from({ length: 6 }, (_, index) => ({
  role: "tool",
  tool_call_id: `window-call-${index}`,
  content: `${index}:${fullOutput}`,
}));
const recentWindow = outputStore.compactMessages(recentWindowMessages, {
  preserveRecentToolResults: 4,
});
assert.strictEqual(recentWindow.compacted, 2);
assert.strictEqual(recentWindow.preservedRecent, 4);
assert.ok(recentWindow.messages[0].content.includes("dao-output://"));
assert.ok(recentWindow.messages[1].content.includes("dao-output://"));
assert.deepStrictEqual(
  recentWindow.messages.slice(2).map((message) => message.content),
  recentWindowMessages.slice(2).map((message) => message.content),
  "the four newest tool results must stay inline for immediate reasoning",
);

function tool(name, description) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: {} },
    },
  };
}

toolStrategy.init({ log: () => {} });
const directTools = [
  tool("read_file", "Read a local file."),
  tool("dao_tool_search", "Discover deferred tools."),
  ...Array.from({ length: 16 }, (_, index) =>
    tool(
      `mcp1_github_action_${index}`,
      `GitHub repository pull request issue operation ${index}. ${"schema detail ".repeat(120)}`,
    ),
  ),
];
const firstSelection = toolStrategy.select({
  key: "dao:tool-test",
  tools: directTools,
  messages: [{ role: "user", content: "review the repository" }],
  maxContextTokens: 32768,
});
assert.strictEqual(firstSelection.stats.enabled, true);
assert.ok(firstSelection.stats.deferredTools >= 16);
assert.deepStrictEqual(
  firstSelection.tools.map((entry) => entry.function.name),
  ["read_file", "dao_tool_search"],
);
const searchResult = toolStrategy.search({
  key: "dao:tool-test",
  query: "GitHub pull request",
  limit: 3,
});
assert.strictEqual(searchResult.ok, true);
assert.strictEqual(searchResult.activated.length, 3);
const secondSelection = toolStrategy.select({
  key: "dao:tool-test",
  tools: directTools,
  messages: [{ role: "user", content: "review the repository" }],
  maxContextTokens: 32768,
});
assert.ok(
  searchResult.activated.every((name) =>
    secondSelection.tools.some((entry) => entry.function.name === name),
  ),
);

const adaptiveThinking = adapters.AnthropicAdapter.buildRequest({
  messages: [{ role: "user", content: "test" }],
  tools: [],
  model: "claude-opus-4-7",
  thinkingEnabled: true,
  thinkingBudget: 16384,
  maxOutputTokens: 4096,
});
assert.deepStrictEqual(adaptiveThinking.thinking, { type: "adaptive" });
assert.deepStrictEqual(adaptiveThinking.output_config, { effort: "high" });
assert.strictEqual("budget_tokens" in adaptiveThinking.thinking, false);

const legacyThinking = adapters.AnthropicAdapter.buildRequest({
  messages: [{ role: "user", content: "test" }],
  tools: [],
  model: "claude-opus-4-5",
  thinkingEnabled: true,
  thinkingBudget: 8192,
  maxOutputTokens: 4096,
});
assert.deepStrictEqual(legacyThinking.thinking, {
  type: "enabled",
  budget_tokens: 8192,
});
assert.strictEqual(legacyThinking.output_config, undefined);

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function routeIntegrationTest() {
  const requestBodies = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requestBodies.length === 1) {
        writeSse(response, {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "search-call",
                    type: "function",
                    function: {
                      name: "dao_tool_search",
                      arguments: JSON.stringify({ query: "GitHub pull request", limit: 4 }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      } else {
        writeSse(response, {
          choices: [{ delta: { content: "Deferred tools activated." } }],
        });
        writeSse(response, {
          choices: [{ delta: {}, finish_reason: "stop" }],
        });
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await listen(server);

  const configPath = path.join(tempDir, "route-config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        mock: {
          enabled: true,
          type: "openai-compatible",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          completionPath: "/v1/chat/completions",
          streamMode: "stream",
          models: ["gpt-5.6-sol"],
        },
      },
      customModels: {
        dao: {
          id: "dao",
          provider: "mock",
          upstreamModel: "gpt-5.6-sol",
          contextTokens: 32768,
          maxOutputTokens: 4096,
        },
      },
      daoRoutes: {
        enabled: true,
        routes: {
          dao: {
            provider: "mock",
            model: "gpt-5.6-sol",
            maxOutputTokens: 4096,
            _customModel: true,
            _customModelId: "dao",
            contextStrategy: {
              enabled: true,
              mode: "proxy-managed",
              proxyManaged: true,
              persistToolOutputs: true,
              deferMcpTools: true,
              maxContextTokens: 32768,
            },
          },
        },
      },
    }),
    "utf8",
  );
  router.init({ configPath, log: () => {} });

  const mcpTools = Array.from({ length: 18 }, (_, index) => ({
    name: `mcp1_github_action_${index}`,
    description: `GitHub pull request and repository action ${index}. ${"schema detail ".repeat(110)}`,
    parameters: { type: "object", properties: {} },
  }));
  const recentToolTranscript = Array.from({ length: 4 }, (_, index) => [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: `recent-call-${index}`, name: "run_command", argumentsJson: "{}" },
      ],
    },
    {
      role: "tool",
      tool_call_id: `recent-call-${index}`,
      content: `recent output ${index}`,
    },
  ]).flat();
  const rawBody = Buffer.from(
    JSON.stringify({
      modelUid: "dao",
      prompt: "You are a coding agent.",
      cascadeId: "cascade-tool-discovery",
      messages: [
        { role: "user", content: "Use GitHub tools after checking the command output." },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "large-call", name: "run_command", argumentsJson: "{}" }],
        },
        { role: "tool", tool_call_id: "large-call", content: fullOutput },
        ...recentToolTranscript,
        { role: "user", content: "Continue." },
      ],
      tools: [
        {
          name: "run_command",
          description: "Run a command.",
          parameters: { type: "object", properties: {} },
        },
        ...mcpTools,
      ],
    }),
  );
  const cascadeResponse = {
    headersSent: false,
    writableEnded: false,
    writeHead() {
      this.headersSent = true;
    },
    write() {
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  assert.strictEqual(await router.route({}, cascadeResponse, rawBody, true, "dao"), true);
  assert.strictEqual(requestBodies.length, 2, "tool discovery should trigger one internal model retry");
  const firstToolNames = requestBodies[0].tools.map((entry) => entry.function.name);
  const secondToolNames = requestBodies[1].tools.map((entry) => entry.function.name);
  assert.ok(firstToolNames.includes("dao_tool_search"));
  assert.ok(firstToolNames.includes("dao_read_tool_output"));
  assert.ok(!firstToolNames.some((name) => /^mcp1_/.test(name)));
  assert.ok(secondToolNames.some((name) => /^mcp1_github_action_/.test(name)));
  const storedResult = requestBodies[0].messages.find(
    (message) => message.role === "tool" && message.tool_call_id === "large-call",
  );
  assert.ok(storedResult.content.includes("dao-output://"));
  assert.ok(router.status().toolStrategy.searches >= 1);
  assert.ok(router.status().toolOutputStore.compactedMessages >= 1);
  assert.strictEqual(
    router.status().contextStrategy.last.checkpointId,
    0,
    "deferred MCP schemas must not falsely trigger context compaction",
  );

  await new Promise((resolve) => server.close(resolve));
}

async function retryCeilingIntegrationTest() {
  const requestBodies = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requestBodies.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (Array.isArray(body.tools) && body.tools.length > 0 && requestBodies.length < 4) {
        writeSse(response, {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: `retry-tool-${requestBodies.length}`,
                type: "function",
                function: {
                  name: "dao_tool_search",
                  arguments: JSON.stringify({ query: "repository action", limit: 2 }),
                },
              }],
            },
            finish_reason: "tool_calls",
          }],
        });
      } else {
        // The retry-ceiling request must still be able to invoke a native
        // workspace tool instead of being forced into text-only synthesis.
        writeSse(response, {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: `native-tool-${requestBodies.length}`,
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "README.md" }),
                },
              }],
            },
            finish_reason: "tool_calls",
          }],
        });
        if (requestBodies.length < 4) {
          response.end("data: [DONE]\n\n");
          return;
        }
        writeSse(response, {
          choices: [{ delta: { content: "Final answer after tool limit." } }],
        });
        writeSse(response, {
          choices: [{ delta: {}, finish_reason: "stop" }],
        });
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await listen(server);

  const configPath = path.join(tempDir, "retry-ceiling-config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        mock: {
          enabled: true,
          type: "openai-compatible",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          completionPath: "/v1/chat/completions",
          streamMode: "stream",
          models: ["gpt-5.6-sol"],
        },
      },
      customModels: {
        dao: {
          id: "dao",
          provider: "mock",
          upstreamModel: "gpt-5.6-sol",
          contextTokens: 32768,
          maxOutputTokens: 4096,
        },
      },
      daoRoutes: {
        enabled: true,
        routes: {
          dao: {
            provider: "mock",
            model: "gpt-5.6-sol",
            maxOutputTokens: 4096,
            _customModel: true,
            _customModelId: "dao",
            contextStrategy: {
              enabled: true,
              mode: "proxy-managed",
              proxyManaged: true,
              persistToolOutputs: true,
              deferMcpTools: true,
              maxContextTokens: 32768,
            },
          },
        },
      },
    }),
    "utf8",
  );
  router.init({ configPath, log: () => {} });

  const response = {
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; },
    write() { return true; },
    end() { this.writableEnded = true; },
  };
  const rawBody = Buffer.from(JSON.stringify({
    modelUid: "dao",
    prompt: "You are a coding agent.",
    cascadeId: "cascade-retry-ceiling",
    messages: [{ role: "user", content: "Inspect and then finish the task." }],
    tools: [
      {
        name: "read_file",
        description: "Read a file from the workspace.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "edit",
        description: "Edit a file in the workspace.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "run_command",
        description: "Run a command in the workspace.",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
      ...Array.from({ length: 18 }, (_, index) => ({
      name: `mcp_retry_action_${index}`,
      description: `Repository action ${index}. ${"schema detail ".repeat(100)}`,
      parameters: { type: "object", properties: {} },
      })),
    ],
  }));

  assert.strictEqual(await router.route({}, response, rawBody, true, "dao"), true);
  assert.strictEqual(requestBodies.length, 4, "three tool rounds should be followed by one forced final response");
  const finalToolNames = (requestBodies[3].tools || []).map(
    (entry) => entry.function && entry.function.name,
  );
  assert.ok(finalToolNames.includes("read_file"), "native read_file must survive the retry ceiling");
  assert.ok(finalToolNames.includes("edit"), "native edit must survive the retry ceiling");
  assert.ok(finalToolNames.includes("run_command"), "native run_command must survive the retry ceiling");
  assert.ok(!finalToolNames.includes("dao_tool_search"), "proxy-local dao_tool_search must be suppressed");
  assert.ok(!finalToolNames.includes("grep_search"), "proxy-local grep_search must be suppressed");
  assert.ok(
    requestBodies[3].messages.some(
      (message) => message.role === "user" && /Do not repeat proxy-local search helpers/.test(message.content || ""),
    ),
    "the final request should preserve client tools and require implementation before summary",
  );
  assert.strictEqual(response.writableEnded, true, "the final response must close cleanly");
  await new Promise((resolve) => server.close(resolve));
}

async function responsesPathIntegrationTest() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        path: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      writeSse(response, {
        type: "response.output_text.delta",
        delta: "Responses path verified.",
      });
      writeSse(response, {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 8, output_tokens: 3 },
        },
      });
      response.end("data: [DONE]\n\n");
    });
  });
  await listen(server);

  const configPath = path.join(tempDir, "responses-path-config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        mock: {
          enabled: true,
          type: "openai-compatible",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          completionPath: "/v1/chat/completions",
          streamMode: "stream",
          models: ["gpt-5.6-sol"],
        },
      },
      customModels: {
        dao: {
          id: "dao",
          provider: "mock",
          upstreamModel: "gpt-5.6-sol",
          protocol: "openai-responses",
          reasoningEffort: "high",
          thinkingEnabled: true,
          contextTokens: 32768,
          maxOutputTokens: 4096,
        },
      },
      daoRoutes: {
        enabled: true,
        routes: {
          dao: {
            provider: "mock",
            model: "gpt-5.6-sol",
            sourceProtocol: "openai-responses",
            reasoningEffort: "high",
            thinkingEnabled: true,
            maxOutputTokens: 4096,
            _customModel: true,
            _customModelId: "dao",
          },
        },
      },
    }),
    "utf8",
  );
  router.init({ configPath, log: () => {} });

  const response = {
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; },
    write() { return true; },
    end() { this.writableEnded = true; },
  };
  const rawBody = Buffer.from(JSON.stringify({
    modelUid: "dao",
    prompt: "You are a coding agent.",
    cascadeId: "cascade-responses-path",
    messages: [{ role: "user", content: "Reply briefly." }],
    tools: [],
  }));

  assert.strictEqual(await router.route({}, response, rawBody, true, "dao"), true);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(
    requests[0].path,
    "/v1/responses",
    "a Responses custom model must override the provider's Chat completion path",
  );
  assert.strictEqual(requests[0].body.reasoning.effort, "high");
  assert.ok(Array.isArray(requests[0].body.input), "Responses requests must use input, not messages");
  assert.strictEqual(requests[0].body.messages, undefined);
  await new Promise((resolve) => server.close(resolve));
}

async function qualityRouteResponsesIntegrationTest() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        path: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      writeSse(response, {
        type: "response.output_text.delta",
        delta: "Quality route verified.",
      });
      writeSse(response, {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 8, output_tokens: 3 },
        },
      });
      response.end("data: [DONE]\n\n");
    });
  });
  await listen(server);

  const configPath = path.join(tempDir, "quality-route-responses-config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        mock: {
          enabled: true,
          type: "openai-compatible",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          completionPath: "/v1/chat/completions",
          streamMode: "stream",
          models: ["gpt-5.6-sol"],
        },
      },
      daoRoutes: {
        enabled: true,
        routes: {
          "claude-opus-4-6-thinking": {
            provider: "mock",
            model: "gpt-5.6-sol",
            thinkingEnabled: false,
            maxOutputTokens: 4096,
          },
        },
      },
    }),
    "utf8",
  );
  router.init({ configPath, log: () => {} });

  const response = {
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; },
    write() { return true; },
    end() { this.writableEnded = true; },
  };
  const rawBody = Buffer.from(JSON.stringify({
    modelUid: "claude-opus-4-6-thinking",
    prompt: "Native tool contract.",
    cascadeId: "cascade-quality-responses",
    messages: [{ role: "user", content: "Inspect the workspace." }],
    tools: [{
      name: "read_file",
      description: "Read a workspace file.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    }],
  }));

  assert.strictEqual(
    await router.route({}, response, rawBody, true, "claude-opus-4-6-thinking"),
    true,
  );
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].path, "/v1/responses");
  assert.strictEqual(requests[0].body.reasoning.effort, "high");
  assert.ok(
    requests[0].body.tools.some((entry) => entry.name === "read_file"),
    "native Devin tools must remain present after the protocol conversion",
  );
  assert.strictEqual(requests[0].body.messages, undefined);
  await new Promise((resolve) => server.close(resolve));
}

async function responsesStreamFailoverIntegrationTest() {
  let primaryHits = 0;
  let backupHits = 0;
  const primary = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      primaryHits++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      writeSse(response, {
        type: "response.failed",
        response: {
          status: "failed",
          error: { code: "upstream_error", message: "primary unavailable" },
        },
      });
      response.end("data: [DONE]\n\n");
    });
  });
  const backup = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      backupHits++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      writeSse(response, {
        type: "response.output_text.delta",
        delta: "backup channel completed",
      });
      writeSse(response, {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 8, output_tokens: 3 } },
      });
      response.end("data: [DONE]\n\n");
    });
  });
  await listen(primary);
  await listen(backup);

  const configPath = path.join(tempDir, "responses-stream-failover-config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    providers: {
      failedResponses: {
        enabled: true,
        type: "openai-compatible",
        protocol: "openai-responses",
        baseUrl: `http://127.0.0.1:${primary.address().port}`,
        streamMode: "stream",
        models: ["gpt-5.6-sol"],
      },
      backupResponses: {
        enabled: true,
        type: "openai-compatible",
        protocol: "openai-responses",
        baseUrl: `http://127.0.0.1:${backup.address().port}`,
        streamMode: "stream",
        models: ["gpt-5.6-sol"],
      },
    },
    daoRoutes: {
      enabled: true,
      routes: {
        dao: {
          provider: "failedResponses",
          model: "gpt-5.6-sol",
          protocol: "openai-responses",
          reasoningLevel: "high",
          autoFallback: true,
          channelPriority: [
            { provider: "failedResponses", model: "gpt-5.6-sol", protocol: "openai-responses" },
            { provider: "backupResponses", model: "gpt-5.6-sol", protocol: "openai-responses" },
          ],
        },
      },
    },
  }), "utf8");
  router.init({ configPath, log: () => {} });

  const response = {
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; },
    write() { return true; },
    end() { this.writableEnded = true; },
  };
  const rawBody = Buffer.from(JSON.stringify({
    modelUid: "dao",
    prompt: "Native Devin contract.",
    cascadeId: "cascade-responses-failover",
    messages: [{ role: "user", content: "Complete the task." }],
    tools: [],
  }));

  assert.strictEqual(await router.route({}, response, rawBody, true, "dao"), true);
  assert.strictEqual(primaryHits, 1);
  assert.strictEqual(backupHits, 1);
  assert.strictEqual(response.writableEnded, true);
  await new Promise((resolve) => primary.close(resolve));
  await new Promise((resolve) => backup.close(resolve));
}

async function nativeDevinContractIntegrationTest() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        path: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      writeSse(response, {
        type: "response.output_text.delta",
        delta: "Native contract verified.",
      });
      writeSse(response, {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 16, output_tokens: 3 },
        },
      });
      response.end("data: [DONE]\n\n");
    });
  });
  await listen(server);

  const configPath = path.join(tempDir, "native-devin-contract-config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        mock: {
          enabled: true,
          type: "openai-compatible",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          completionPath: "/v1/chat/completions",
          streamMode: "stream",
          models: ["gpt-5.6-sol"],
        },
      },
      customModels: {
        dao: {
          id: "dao",
          provider: "mock",
          upstreamModel: "gpt-5.6-sol",
          protocol: "openai-responses",
          reasoningLevel: "high",
          contextTokens: 131072,
          maxOutputTokens: 4096,
        },
      },
      daoRoutes: {
        enabled: true,
        routes: {
          dao: {
            provider: "mock",
            model: "gpt-5.6-sol",
            sourceProtocol: "openai-responses",
            reasoningLevel: "high",
            reasoningEffort: "high",
            thinkingEnabled: true,
            maxOutputTokens: 4096,
            _customModel: true,
            _customModelId: "dao",
            contextStrategy: { enabled: true },
          },
        },
      },
    }),
    "utf8",
  );
  router.init({ configPath, log: () => {} });

  const nativeSystem = [
    "You are Cascade, a powerful agentic AI coding assistant.",
    "",
    "",
    "Keep Devin's native tool and workspace contract exactly as supplied.",
  ].join("\n");
  const largeNativeOutput = `ROOT=E:\\project\n${"native-result-line\n".repeat(900)}`;
  const nativeToolHistory = Array.from({ length: 5 }, (_, index) => [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: `native-call-${index}`, name: "FindByName", argumentsJson: "{}" },
      ],
    },
    {
      role: "tool",
      tool_call_id: `native-call-${index}`,
      content: `${index}:${largeNativeOutput}`,
    },
  ]).flat();
  const nativeTools = [
    {
      name: "create_memory",
      description: "Devin native memory tool for Cascade.",
      parameters: { type: "object", properties: { text: { type: "string" } } },
    },
    {
      name: "FindByName",
      description: "Use Devin's registered workspace index.",
      parameters: { type: "object", properties: { pattern: { type: "string" } } },
    },
  ];
  const rawBody = Buffer.from(JSON.stringify({
    modelUid: "dao",
    prompt: nativeSystem,
    cascadeId: "cascade-native-contract",
    messages: [
      { role: "user", content: "Locate the existing page." },
      ...nativeToolHistory,
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "native-unmatched", name: "FindByName", argumentsJson: "{}" }],
      },
      { role: "user", content: "Continue in the same conversation." },
    ],
    tools: nativeTools,
  }));
  const response = {
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; },
    write() { return true; },
    end() { this.writableEnded = true; },
  };

  assert.strictEqual(await router.route({}, response, rawBody, true, "dao"), true);
  assert.strictEqual(requests.length, 1, "native tools must not trigger proxy retries");
  const captured = requests[0];
  assert.strictEqual(captured.path, "/v1/responses");
  assert.strictEqual(captured.body.instructions, nativeSystem);
  assert.deepStrictEqual(
    captured.body.tools.map((tool) => tool.name),
    nativeTools.map((tool) => tool.name),
    "Responses routes must preserve the untouched Devin tool list by default",
  );
  assert.strictEqual(captured.body.tools[0].description, nativeTools[0].description);
  const nativeToolOutput = captured.body.input.find(
    (item) => item.type === "function_call_output" && item.call_id === "native-call-0",
  );
  assert.strictEqual(
    nativeToolOutput && nativeToolOutput.output,
    `0:${largeNativeOutput}`,
    "native mode must keep old tool results inline",
  );
  const recentNativeOutputs = captured.body.input.filter(
    (item) =>
      item.type === "function_call_output" &&
      /^native-call-[1-4]$/.test(item.call_id || ""),
  );
  assert.deepStrictEqual(
    recentNativeOutputs.map((item) => item.output),
    [1, 2, 3, 4].map((index) => `${index}:${largeNativeOutput}`),
    "the four newest native tool results must remain inline",
  );
  assert.strictEqual(JSON.stringify(captured.body).includes("dao_tool_search"), false);
  assert.strictEqual(JSON.stringify(captured.body).includes("dao_read_tool_output"), false);
  assert.strictEqual(JSON.stringify(captured.body).includes("Custom-model execution policy"), false);
  assert.strictEqual(
    captured.body.input.some(
      (item) =>
        item.type === "function_call_output" &&
        item.call_id === "native-unmatched",
    ),
    false,
    "devin-native mode must not invent a tool result that Devin did not send",
  );

  const managedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  managedConfig.daoRoutes.routes.dao.contextStrategy.persistToolOutputs = true;
  fs.writeFileSync(configPath, JSON.stringify(managedConfig), "utf8");
  router.init({ configPath, log: () => {} });
  const optOutResponse = {
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; },
    write() { return true; },
    end() { this.writableEnded = true; },
  };
  assert.strictEqual(
    await router.route({}, optOutResponse, rawBody, true, "dao"),
    true,
  );
  const managedBody = requests[1].body;
  assert.deepStrictEqual(
    managedBody.tools.map((tool) => tool.name),
    [...nativeTools.map((tool) => tool.name), "dao_read_tool_output"],
    "explicit persistence must append the stable output reader",
  );
  const managedOldest = managedBody.input.find(
    (item) =>
      item.type === "function_call_output" && item.call_id === "native-call-0",
  );
  assert.ok(
    managedOldest && managedOldest.output.includes("dao-output://"),
    "explicit persistence must replace older large outputs with stable references",
  );
  await new Promise((resolve) => server.close(resolve));
}

Promise.resolve()
  .then(routeIntegrationTest)
  .then(retryCeilingIntegrationTest)
  .then(responsesPathIntegrationTest)
  .then(qualityRouteResponsesIntegrationTest)
  .then(responsesStreamFailoverIntegrationTest)
  .then(nativeDevinContractIntegrationTest)
  .then(() => {
    console.log("tool strategy tests passed");
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

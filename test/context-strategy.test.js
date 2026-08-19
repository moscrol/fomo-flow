"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const contextStrategy = require("../vendor/外接api/core/context_strategy");
const router = require("../vendor/外接api/core/dao_router");
const adapters = require("../vendor/外接api/core/adapters");

contextStrategy.init({ log: () => {} });

const messages = [
  { role: "system", content: "You are a coding agent. Keep the workspace correct." },
  { role: "user", content: "Plan mode is active. Implement the requested feature and verify it." },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "todo-state",
        type: "function",
        function: { name: "todo_list", arguments: "{}" },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "todo-state",
    content: "1. inspect complete\n2. implementation in progress\n3. validation pending",
  },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "running-command",
        type: "function",
        function: { name: "run_command", arguments: "{}" },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "running-command",
    content: "Command is still running. session_id=build-42",
  },
];
for (let index = 0; index < 72; index++) {
  const id = `call-${index}`;
  messages.push({
    role: "assistant",
    content: index % 8 === 0 ? `Milestone ${index}: continue implementation.` : null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name: "read_file", arguments: `{"path":"file-${index}.js"}` },
      },
    ],
  });
  messages.push({
    role: "tool",
    tool_call_id: id,
    content: `Exit code: 0\nOutput:\n${`result-${index} `.repeat(850)}`,
  });
}
messages.push({ role: "user", content: "Finish the implementation now." });

const tools = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a command.",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "command_status",
      description: "Check a running command.",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "Edit",
      description: "Edit a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, patch: { type: "string" } },
        required: ["path", "patch"],
      },
    },
  },
];

const first = contextStrategy.apply({
  key: "dao:test-context",
  messages,
  tools,
  maxContextTokens: 131072,
  maxOutputTokens: 16384,
  highWaterTokens: 100000,
  lowWaterTokens: 65000,
});

assert.ok(first.stats.rawTokens > 100000, "synthetic history must cross the high watermark");
assert.ok(first.stats.sentTokens <= 65000, "checkpoint should return near the low watermark");
assert.ok(first.stats.savedTokens >= 20000, "compaction should happen in a cache-worthy block");
assert.strictEqual(first.stats.checkpointId, 1);
assert.strictEqual(first.stats.checkpointReused, false);
assert.ok(first.stats.trimmedMessages > 0);
const firstCheckpointIndex = first.messages.findIndex((message) =>
  String(message.content || "").includes("<!-- DAO-CONTEXT-CHECKPOINT -->"));
assert.ok(firstCheckpointIndex > 1, "checkpoint follows the immutable task anchor");
assert.ok(
  first.messages[firstCheckpointIndex].content.includes("DAO conversation checkpoint #1"),
  "checkpoint summary is carried by a Harness context message",
);
assert.ok(
  first.messages[0].content.startsWith(messages[0].content),
  "compaction must preserve the original Devin system prompt as the cache prefix",
);
assert.ok(
  first.messages[0].content.includes("Custom-model execution policy"),
  "custom execution policy must be stable in the system prefix",
);
assert.doesNotMatch(first.messages[0].content, /DAO conversation checkpoint/);
assert.strictEqual(first.messages[1].content, messages[1].content);
assert.ok(first.messages[firstCheckpointIndex].content.includes("Active execution mode: plan"));
assert.ok(JSON.stringify(first.messages).includes("validation pending"));
assert.ok(JSON.stringify(first.messages).includes("session_id=build-42"));

for (let index = 0; index < first.messages.length; index++) {
  const message = first.messages[index];
  if (message.role !== "tool") continue;
  const previous = first.messages[index - 1];
  assert.ok(previous && previous.role === "assistant", "tool result must keep its assistant pair");
  assert.ok(
    previous.tool_calls.some((call) => call.id === message.tool_call_id),
    "tool result id must match the retained assistant call",
  );
}

const continuedMessages = [
  ...messages,
  { role: "assistant", content: "The edit is complete." },
  { role: "user", content: "Run the focused validation." },
];
const second = contextStrategy.apply({
  key: "dao:test-context",
  messages: continuedMessages,
  tools,
  maxContextTokens: 131072,
  maxOutputTokens: 16384,
  highWaterTokens: 100000,
  lowWaterTokens: 65000,
});

assert.strictEqual(second.stats.checkpointId, 1, "small continuations must keep the same checkpoint");
assert.strictEqual(second.stats.checkpointReused, true, "continuation must reuse the checkpoint anchor");
assert.strictEqual(contextStrategy.status().sessions, 1);
assert.strictEqual(contextStrategy.status().last.checkpointReused, true);
assert.strictEqual(
  second.messages[0].content,
  first.messages[0].content,
  "reused checkpoint must keep a byte-stable system prefix for prompt caching",
);
assert.deepStrictEqual(
  second.messages.slice(0, first.messages.length),
  first.messages,
  "reused checkpoint must only append new messages",
);

const rollingContinuation = [...continuedMessages];
for (let index = 0; index < 40; index++) {
  const id = `rolling-${index}`;
  rollingContinuation.push({
    role: "assistant",
    content: null,
    tool_calls: [{
      id,
      type: "function",
      function: { name: "read_file", arguments: `{"path":"rolling-${index}.js"}` },
    }],
  });
  rollingContinuation.push({
    role: "tool",
    tool_call_id: id,
    content: `Exit code: 0\n${`rolling-result-${index} `.repeat(900)}`,
  });
}
rollingContinuation.push({ role: "user", content: "Finish after the rolling checkpoint." });
const rolled = contextStrategy.apply({
  key: "dao:test-context",
  messages: rollingContinuation,
  tools,
  maxContextTokens: 131072,
  maxOutputTokens: 16384,
  highWaterTokens: 100000,
  lowWaterTokens: 65000,
});
assert.strictEqual(rolled.stats.checkpointId, 2);
const rolledCheckpointIndex = rolled.messages.findIndex((message) =>
  String(message.content || "").includes("<!-- DAO-CONTEXT-CHECKPOINT -->"));
assert.strictEqual(rolledCheckpointIndex, firstCheckpointIndex);
assert.deepStrictEqual(
  rolled.messages.slice(0, rolledCheckpointIndex),
  first.messages.slice(0, firstCheckpointIndex),
  "rolling checkpoint changes must preserve system and initial task anchor bytes",
);
assert.notStrictEqual(
  rolled.messages[rolledCheckpointIndex].content,
  first.messages[firstCheckpointIndex].content,
);

const decorated = contextStrategy.decorateTools(tools);
assert.ok(decorated[0].function.description.includes("exit code or final output"));
assert.ok(decorated[1].function.description.includes("Poll that id once"));
assert.ok(decorated[2].function.description.includes("exact file path"));
assert.ok(decorated[2].function.description.includes("Never emit an empty or pathless edit call"));
assert.strictEqual(tools[0].function.description, "Run a command.", "tool decoration must not mutate LSP input");

contextStrategy.init({ log: () => {} });
const activeTurn = contextStrategy.apply({
  key: "dao:active-turn",
  messages: messages.slice(0, -1),
  tools,
  maxContextTokens: 131072,
  maxOutputTokens: 16384,
  highWaterTokens: 100000,
  lowWaterTokens: 65000,
});
assert.ok(activeTurn.stats.trimmedMessages > 0);
assert.strictEqual(
  activeTurn.messages.find((message) => message.role !== "system").content,
  messages[1].content,
  "an oversized active tool turn must retain its latest user objective verbatim",
);
for (let index = 0; index < activeTurn.messages.length; index++) {
  const message = activeTurn.messages[index];
  if (message.role !== "tool") continue;
  const previous = activeTurn.messages[index - 1];
  assert.ok(previous && previous.role === "assistant");
  assert.ok(previous.tool_calls.some((call) => call.id === message.tool_call_id));
}
const activeTurnContinued = contextStrategy.apply({
  key: "dao:active-turn",
  messages: [
    ...messages.slice(0, -1),
    { role: "assistant", content: "The tool-heavy inspection is complete." },
    { role: "user", content: "Apply the verified fix now." },
  ],
  tools,
  maxContextTokens: 131072,
  maxOutputTokens: 16384,
  highWaterTokens: 100000,
  lowWaterTokens: 65000,
});
assert.strictEqual(activeTurnContinued.stats.checkpointReused, true);
assert.deepStrictEqual(
  activeTurnContinued.messages.slice(0, activeTurn.messages.length),
  activeTurn.messages,
  "a checkpoint with an anchored user objective must keep a byte-stable cached prefix",
);

assert.strictEqual(adapters.pickContextLength("gpt-5.6-sol"), 1050000);
assert.strictEqual(adapters.pickContextLength("gpt-5.6-terra"), 1050000);
assert.strictEqual(adapters.pickContextLength("gpt-5.6-luna"), 400000);

contextStrategy.init({ log: () => {} });
const stableHistory = [
  { role: "system", content: "You are a coding agent for this project." },
  { role: "user", content: "Implement the video page and verify it." },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "read-video",
        type: "function",
        function: { name: "Read", arguments: '{"path":"Video.uxml"}' },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "read-video",
    content: "Video.uxml contains MiddleCard, VideoPanel and VideoControls.",
  },
  { role: "assistant", content: "The runtime page still needs a registered controller." },
  { role: "user", content: "Proceed with the minimal runtime chain." },
];
const continuityFirst = contextStrategy.apply({
  key: "dao:continuity",
  messages: stableHistory,
  tools,
  maxContextTokens: 131072,
  maxOutputTokens: 16384,
  highWaterTokens: 100000,
  lowWaterTokens: 65000,
});
assert.strictEqual(continuityFirst.stats.continuityRecovered, false);

const rewrittenHistory = [
  { role: "system", content: "You are a coding agent for this project." },
  {
    role: "user",
    content: "Earlier conversation was compacted after locating the video UXML.",
  },
  { role: "assistant", content: "The runtime page still needs a registered controller." },
  { role: "user", content: "Proceed with the minimal runtime chain." },
  { role: "user", content: "继续，不要重新搜索已经确认的文件。" },
];
const continuitySecond = contextStrategy.apply({
  key: "dao:continuity",
  messages: rewrittenHistory,
  tools,
  maxContextTokens: 131072,
  maxOutputTokens: 16384,
  highWaterTokens: 100000,
  lowWaterTokens: 65000,
});
assert.strictEqual(
  continuitySecond.stats.continuityRecovered,
  true,
  "a rewritten client transcript should recover the last sent prefix",
);
assert.strictEqual(continuitySecond.stats.continuityOverlapMessages, 2);
assert.strictEqual(continuitySecond.stats.continuityDroppedMessages, 1);
assert.deepStrictEqual(
  continuitySecond.messages.slice(0, continuityFirst.messages.length),
  continuityFirst.messages,
  "recovery must preserve the exact previous upstream prefix for caching",
);
assert.strictEqual(
  continuitySecond.messages.at(-1).content,
  "继续，不要重新搜索已经确认的文件。",
);
assert.strictEqual(contextStrategy.status().continuityRecoveries, 1);

const intentionalBranch = contextStrategy.apply({
  key: "dao:continuity",
  messages: [
    { role: "system", content: "You are a coding agent for this project." },
    { role: "user", content: "Discard the previous task and build a new login page." },
  ],
  tools,
  maxContextTokens: 131072,
  maxOutputTokens: 16384,
  highWaterTokens: 100000,
  lowWaterTokens: 65000,
});
assert.strictEqual(
  intentionalBranch.stats.continuityRecovered,
  false,
  "a branch with no retained overlap must not splice the old task back in",
);
assert.strictEqual(intentionalBranch.messages.length, 2);

const chatReasoning = router._test.requestReasoningSettings(
  { _customModel: true, reasoningEffort: "high", thinkingEnabled: false },
  "openai-chat",
  "kfcoding/gpt-5.6-sol",
  true,
);
assert.strictEqual(chatReasoning.reasoningEffort, "none");
assert.strictEqual(chatReasoning.adjusted, true);

const responsesReasoning = router._test.requestReasoningSettings(
  { _customModel: true, reasoningEffort: "high", thinkingEnabled: true },
  "openai-responses",
  "kfcoding/gpt-5.6-sol",
  true,
);
assert.strictEqual(responsesReasoning.reasoningEffort, "high");
assert.strictEqual(responsesReasoning.adjusted, false);
assert.strictEqual(
  router._test.isReasoningParamUnsupportedResponse(
    400,
    "Invalid reasoning_effort: none is not supported",
  ),
  true,
);
assert.strictEqual(
  router._test.isReasoningParamUnsupportedResponse(400, "Invalid tool schema"),
  false,
);

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function routeIntegrationTest() {
  const capturedBodies = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      capturedBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await listen(server);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dao-context-route-"));
  const configPath = path.join(tempDir, "config.json");
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
          contextTokens: 131072,
          maxOutputTokens: 16384,
        },
      },
      daoRoutes: {
        enabled: true,
        routes: {
          dao: {
            provider: "mock",
            model: "gpt-5.6-sol",
            maxOutputTokens: 16384,
            _customModel: true,
            _customModelId: "dao",
            contextStrategy: {
              enabled: true,
              mode: "proxy-managed",
              proxyManaged: true,
            },
          },
        },
      },
    }),
    "utf8",
  );
  router.init({ configPath, log: () => {} });

  const rawBody = Buffer.from(
    JSON.stringify({
      modelUid: "dao",
      prompt: "You are a coding agent.",
      cascadeId: "cascade-context-integration",
      messages: [
        { role: "user", content: "Inspect one file and report the result." },
        { role: "assistant", content: "Video.uxml was located and inspected." },
        { role: "user", content: "Proceed with the minimal runtime chain." },
      ],
      tools: [
        {
          name: "run_command",
          description: "Run a command.",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
        {
          name: "command_status",
          description: "Check command status.",
          parameters: { type: "object", properties: { id: { type: "string" } } },
        },
        {
          name: "Edit",
          description: "Edit a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, patch: { type: "string" } },
            required: ["path", "patch"],
          },
        },
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
  const capturedBody = capturedBodies[0];
  assert.ok(capturedBody, "mock upstream must capture the real provider request");
  assert.strictEqual(capturedBody.reasoning_effort, "none");
  assert.ok(capturedBody.messages[0].content.includes("Custom-model execution policy"));
  const actualTools = Object.fromEntries(
    capturedBody.tools.map((tool) => [tool.function.name, tool.function]),
  );
  assert.ok(actualTools.run_command.description.includes("exit code or final output"));
  assert.ok(actualTools.command_status.description.includes("Poll that id once"));
  assert.ok(actualTools.Edit.description.includes("exact file path"));
  assert.ok(router.status().contextStrategy.last.rawTokens > 0);

  const continuedRawBody = Buffer.from(
    JSON.stringify({
      modelUid: "dao",
      prompt: "You are a coding agent.",
      cascadeId: "cascade-context-integration",
      messages: [
        {
          role: "user",
          content: "Earlier history was compacted after locating the video page.",
        },
        { role: "assistant", content: "Video.uxml was located and inspected." },
        { role: "user", content: "Proceed with the minimal runtime chain." },
        { role: "user", content: "继续并完成修改。" },
      ],
      tools: [
        {
          name: "run_command",
          description: "Run a command.",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
        {
          name: "command_status",
          description: "Check command status.",
          parameters: { type: "object", properties: { id: { type: "string" } } },
        },
        {
          name: "Edit",
          description: "Edit a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, patch: { type: "string" } },
            required: ["path", "patch"],
          },
        },
      ],
    }),
  );
  const continuedResponse = {
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
  assert.strictEqual(
    await router.route({}, continuedResponse, continuedRawBody, true, "dao"),
    true,
  );
  const continuedBody = capturedBodies[1];
  assert.ok(continuedBody, "mock upstream must capture the continued request");
  const stableMessages = (messages) => messages.filter((message) =>
    !String(message && message.content || "").includes("<!--dao-agent-status-->"),
  );
  const initialStableMessages = stableMessages(capturedBody.messages);
  const continuedStableMessages = stableMessages(continuedBody.messages);
  assert.deepStrictEqual(
    continuedStableMessages.slice(0, initialStableMessages.length),
    initialStableMessages,
    "real provider requests must keep the previous byte-stable message prefix after client truncation",
  );
  assert.strictEqual(
    continuedStableMessages.at(-1).content,
    "继续并完成修改。",
  );
  assert.strictEqual(router.status().contextStrategy.last.continuityRecovered, true);

  await new Promise((resolve) => server.close(resolve));
}

routeIntegrationTest()
  .then(() => {
    console.log("context strategy tests passed");
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

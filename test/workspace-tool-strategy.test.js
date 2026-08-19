"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const isolatedHome = fs.mkdtempSync(
  path.join(os.tmpdir(), "dao-workspace-tool-strategy-home-"),
);
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.on("exit", () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

const strategy = require("../vendor/外接api/core/workspace_tool_strategy");
const simulator = require("../vendor/外接api/core/lsp_simulator");

function tool(name) {
  return {
    type: "function",
    function: { name, description: `${name} description`, parameters: {} },
  };
}

function names(tools) {
  return tools.map((item) => item.function.name);
}

function failedWorkspaceMessages(root, callId = "call_workspace_1") {
  return [
    {
      role: "system",
      content: `项目根目录：${root}\n请严格依据项目文档实施。`,
    },
    { role: "user", content: "定位视频页面脚本。" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name: "CodeSearch",
            arguments: JSON.stringify({ query: "Video.uxml" }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: callId,
      content: "当前 IDE 未注册工作区，因此拒绝了该绝对路径。",
    },
  ];
}

const allTools = [
  tool("CodeSearch"),
  tool("code_search"),
  tool("SmartReading"),
  tool("smart_reading"),
  tool("Grep"),
  tool("grep_search"),
  tool("trajectory_search"),
  tool("Read"),
  tool("FindByName"),
  tool("find_by_name"),
  tool("ListDir"),
  tool("run_command"),
];

strategy.init();

const first = strategy.observe({
  key: "dao:cascade-a",
  messages: failedWorkspaceMessages("E:\\新增运行时状态机"),
});
assert.equal(first.degraded, true, "workspace boundary failure should degrade the session");
assert.equal(first.failures, 1, "failure should be counted once");

const filtered = strategy.filterTools({ key: "dao:cascade-a", tools: allTools });
const filteredNames = names(filtered);
for (const disabledName of [
  "CodeSearch",
  "code_search",
  "SmartReading",
  "smart_reading",
  "Grep",
  "grep_search",
  "FindByName",
  "find_by_name",
]) {
  assert.equal(
    filteredNames.includes(disabledName),
    false,
    `${disabledName} should be removed from the next upstream tool set`,
  );
}
for (const retainedName of [
  "trajectory_search",
  "Read",
  "ListDir",
  "run_command",
]) {
  assert.equal(
    filteredNames.includes(retainedName),
    true,
    `${retainedName} should remain available`,
  );
}

const decorated = strategy.decorateMessages({
  key: "dao:cascade-a",
  messages: failedWorkspaceMessages("E:\\新增运行时状态机"),
});
assert.match(
  decorated[0].content,
  /separate workspace-bound search executor rejected the current root/,
  "system prompt should explain the editor/search-executor registry split",
);
assert.match(
  decorated[0].content,
  /Do not call CodeSearch, SmartReading, Grep, grep_search, FindByName, or find_by_name again/,
  "system prompt should forbid retries after the confirmed failure",
);
assert.match(
  decorated[0].content,
  /Do not claim that the user failed to open the project/,
  "system prompt should distinguish the search executor from the open editor workspace",
);

const repeated = strategy.observe({
  key: "dao:cascade-a",
  messages: failedWorkspaceMessages("E:\\新增运行时状态机"),
});
assert.equal(repeated.failures, 1, "the same historical failure should not be recounted");
assert.deepEqual(
  strategy.filterTools({ key: "dao:cascade-a", tools: allTools }),
  filtered,
  "the same session should keep a stable filtered tool prefix",
);
assert.deepEqual(
  strategy.decorateMessages({
    key: "dao:cascade-a",
    messages: failedWorkspaceMessages("E:\\新增运行时状态机"),
  }),
  decorated,
  "the degraded directive should remain byte-stable for prompt caching",
);

const freshSession = strategy.filterTools({
  key: "dao:cascade-b",
  tools: allTools,
});
assert.deepEqual(names(freshSession), names(allTools), "a new Cascade must not inherit the fuse");

const changedRoot = strategy.observe({
  key: "dao:cascade-a",
  messages: [
    {
      role: "system",
      content: "项目根目录：E:\\另一个项目\n使用项目内工具完成修改。",
    },
    { role: "user", content: "开始处理新项目。" },
  ],
});
assert.equal(changedRoot.reset, true, "changing the explicit project root should reset state");
assert.equal(changedRoot.degraded, false, "the new project should get a fresh capability state");
assert.deepEqual(
  names(strategy.filterTools({ key: "dao:cascade-a", tools: allTools })),
  names(allTools),
  "tools should be restored after project-root reset",
);

strategy.init();
strategy.observe({
  key: "dao:cascade-c",
  messages: [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_network",
          type: "function",
          function: { name: "CodeSearch", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_network",
      content: "HTTP 503: temporary network failure",
    },
  ],
});
assert.deepEqual(
  names(strategy.filterTools({ key: "dao:cascade-c", tools: allTools })),
  names(allTools),
  "unrelated failures must not disable workspace tools",
);

assert.equal(
  strategy._test.isWorkspaceBoundaryError(
    "The path is not inside the IDE-registered workspace",
  ),
  true,
  "English workspace errors should be recognized",
);
assert.equal(
  strategy._test.isWorkspaceBoundaryError(
    "Search path E:/新增运行时状态机/Assets is not within any current workspace.\nCurrent open workspaces:",
  ),
  true,
  "the real empty Cortex workspace error should be recognized",
);
assert.equal(
  strategy._test.isWorkspaceIndexTool("grep_search"),
  true,
  "grep_search should share the workspace-search fuse",
);
assert.equal(
  strategy._test.isWorkspaceIndexTool("find_by_name"),
  true,
  "find_by_name should share the workspace-search fuse",
);
strategy.init();
const realGrepFailure = strategy.observe({
  key: "dao:cascade-real-grep",
  messages: [
    { role: "system", content: "Project root: E:\\project" },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_real_grep",
          type: "function",
          function: {
            name: "grep_search",
            arguments: JSON.stringify({ SearchPath: "E:/project/Assets", Query: "Video" }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_real_grep",
      content:
        "Search path E:/project/Assets is not within any current workspace.\nCurrent open workspaces:",
    },
  ],
});
assert.equal(realGrepFailure.degraded, true, "the real grep failure should trip the fuse");
const realGrepFiltered = names(
  strategy.filterTools({ key: "dao:cascade-real-grep", tools: allTools }),
);
assert.equal(realGrepFiltered.includes("grep_search"), false);
assert.equal(realGrepFiltered.includes("Grep"), false);
assert.equal(realGrepFiltered.includes("FindByName"), false);
assert.equal(realGrepFiltered.includes("find_by_name"), false);
assert.equal(realGrepFiltered.includes("Read"), true);
assert.equal(
  strategy._test.projectRoot(failedWorkspaceMessages("E:\\新增运行时状态机")),
  "e:/新增运行时状态机",
  "the injected project root should be normalized deterministically",
);

strategy.init({ localFallback: true });
strategy.observe({ key: "dao:local-recovery", messages: failedWorkspaceMessages() });
assert.equal(
  strategy.isLocalFallbackActive({ key: "dao:local-recovery" }),
  true,
  "proxy-local search should activate only after a native workspace failure",
);
assert.equal(
  strategy.isLocalFallbackActive({ key: "dao:fresh-native-search" }),
  false,
  "fresh sessions should keep native workspace search",
);
const recoveredNames = names(
  strategy.filterTools({ key: "dao:local-recovery", tools: allTools }),
);
assert.equal(recoveredNames.includes("code_search"), true);
assert.equal(recoveredNames.includes("grep_search"), true);
assert.match(
  strategy.decorateMessages({
    key: "dao:local-recovery",
    messages: failedWorkspaceMessages(),
  })[0].content,
  /proxy-local search executor is now active/,
);

console.log("workspace-tool-strategy: 32 assertions passed");

function mockResponse() {
  const chunks = [];
  return {
    headersSent: false,
    writableEnded: false,
    writeHead() {
      this.headersSent = true;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
    end() {
      this.writableEnded = true;
    },
    body() {
      return Buffer.concat(chunks);
    },
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function integrationTest() {
  let upstreamBody = null;
  const server = http.createServer(async (request, response) => {
    upstreamBody = JSON.parse((await readBody(request)) || "{}");
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data:${JSON.stringify({
        id: "workspace-test",
        model: "workspace-model",
        choices: [{ delta: { role: "assistant", content: "fallback tools ready" } }],
      })}\n\n`,
    );
    response.write(
      `data:${JSON.stringify({
        id: "workspace-test",
        model: "workspace-model",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`,
    );
    response.end("data:[DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const configPath = path.join(
    os.tmpdir(),
    `dao-workspace-strategy-${process.pid}-${Date.now()}.json`,
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      gateway: { host: "127.0.0.1", port: 11435 },
      providers: {
        local: {
          enabled: true,
          apiKey: "test-key",
          baseUrl: `http://127.0.0.1:${port}`,
          completionPath: "/chat/completions",
          noProviderPrefix: true,
          protocol: "openai-chat",
          type: "openai-compatible",
          streamMode: "stream",
        },
      },
      customModels: {
        "workspace-model": {
          id: "workspace-model",
          provider: "local",
          upstreamModel: "workspace-model",
          contextTokens: 131072,
          maxOutputTokens: 4096,
        },
      },
      daoRoutes: {
        enabled: true,
        routes: {
          MODEL_WORKSPACE_TEST: {
            provider: "local",
            model: "workspace-model",
            maxOutputTokens: 4096,
            _customModel: true,
            _customModelId: "workspace-model",
            contextStrategy: {
              enabled: true,
              mode: "proxy-managed",
              proxyManaged: true,
            },
          },
        },
      },
    }),
  );

  try {
    const initialized = simulator.Router.init({ log: () => {}, configPath });
    assert.equal(initialized.ready, true, "router integration config should initialize");
    const request = simulator.buildReq({
      cascadeId: "cascade-workspace-integration",
      modelUid: "MODEL_WORKSPACE_TEST",
      system: "项目根目录：E:\\新增运行时状态机\n按项目规则执行。",
      messages: failedWorkspaceMessages("E:\\新增运行时状态机").slice(1),
      tools: allTools,
      toolChoice: "auto",
    });
    const response = mockResponse();
    const routed = await simulator.Router.route(
      { on: () => {} },
      response,
      request,
      false,
      "MODEL_WORKSPACE_TEST",
    );
    assert.equal(routed, true, "the integration request should route successfully");
    assert.ok(upstreamBody, "the mock upstream should receive a request body");
    const upstreamNames = names(upstreamBody.tools || []);
    assert.equal(upstreamNames.includes("CodeSearch"), true);
    assert.equal(upstreamNames.includes("code_search"), true);
    assert.equal(upstreamNames.includes("SmartReading"), true);
    assert.equal(upstreamNames.includes("smart_reading"), true);
    assert.equal(upstreamNames.includes("Grep"), true);
    assert.equal(upstreamNames.includes("grep_search"), true);
    assert.equal(upstreamNames.includes("FindByName"), true);
    assert.equal(upstreamNames.includes("find_by_name"), true);
    assert.equal(upstreamNames.includes("Read"), true);
    assert.equal(upstreamNames.includes("run_command"), true);
    assert.equal(upstreamNames.includes("trajectory_search"), true);
    assert.match(
      upstreamBody.messages[0].content,
      /proxy-local search executor is now active/,
      "the final upstream system prompt should contain the local recovery directive",
    );
    assert.equal(
      simulator.Router._test.workspaceToolStrategyStatus().degradedSessions,
      1,
      "router status should expose the degraded session",
    );
    assert.equal(
      simulator.Router._test.workspaceToolStrategyStatus().localFallback,
      true,
      "router should retain search tools when the proxy-local executor is available",
    );
    console.log("workspace-tool-strategy integration: 15 assertions passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.unlinkSync(configPath);
    } catch {}
  }
}

async function proactiveGrepOnlyIntegrationTest() {
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "dao-grep-only-workspace-"),
  );
  const scriptsRoot = path.join(workspaceRoot, "Assets", "Scripts");
  fs.mkdirSync(scriptsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsRoot, "WorkspaceProbe.cs"),
    "public class WorkspaceProbe { void GrepOnlySentinel() {} }\n",
    "utf8",
  );

  const requestBodies = [];
  const server = http.createServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)) || "{}");
    requestBodies.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (requestBodies.length === 1) {
      response.write(
        `data:${JSON.stringify({
          type: "response.output_text.delta",
          delta: "TRANSIENT_STEP_NARRATION_MUST_NOT_REPEAT",
        })}\n\n`,
      );
      response.write(
        `data:${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call_grep_only",
            name: "grep_search",
          },
        })}\n\n`,
      );
      response.write(
        `data:${JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call_grep_only",
            name: "grep_search",
            arguments: JSON.stringify({
              SearchPath: scriptsRoot,
              Query: "GrepOnlySentinel",
            }),
          },
        })}\n\n`,
      );
      response.write(
        `data:${JSON.stringify({
          type: "response.completed",
          response: { status: "completed" },
        })}\n\n`,
      );
    } else if (requestBodies.length === 2) {
      response.write(
        `data:${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call_code_search_after_grep",
            name: "code_search",
          },
        })}\n\n`,
      );
      response.write(
        `data:${JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call_code_search_after_grep",
            name: "code_search",
            arguments: JSON.stringify({
              search_folder_absolute_uri: workspaceRoot,
              search_term: "registration and navigation",
            }),
          },
        })}\n\n`,
      );
      response.write(
        `data:${JSON.stringify({
          type: "response.completed",
          response: { status: "completed" },
        })}\n\n`,
      );
    } else {
      response.write(
        `data:${JSON.stringify({
          type: "response.output_text.delta",
          delta: "All workspace steps completed without repeating grep.",
        })}\n\n`,
      );
      response.write(
        `data:${JSON.stringify({
          type: "response.completed",
          response: { status: "completed" },
        })}\n\n`,
      );
    }
    response.end("data:[DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const configPath = path.join(
    os.tmpdir(),
    `dao-grep-only-${process.pid}-${Date.now()}.json`,
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        local: {
          enabled: true,
          apiKey: "test-key",
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          completionPath: "/v1/responses",
          noProviderPrefix: true,
          protocol: "openai-responses",
          type: "openai-compatible",
          streamMode: "stream",
        },
      },
      customModels: {
        "grep-only-model": {
          id: "grep-only-model",
          provider: "local",
          upstreamModel: "grep-only-model",
          protocol: "openai-responses",
          contextTokens: 131072,
          maxOutputTokens: 4096,
        },
      },
      daoRoutes: {
        enabled: true,
        routes: {
          MODEL_GREP_ONLY_TEST: {
            provider: "local",
            model: "grep-only-model",
            sourceProtocol: "openai-responses",
            maxOutputTokens: 4096,
            _customModel: true,
            _customModelId: "grep-only-model",
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

  try {
    const initialized = simulator.Router.init({ log: () => {}, configPath });
    assert.equal(initialized.ready, true);
    const request = simulator.buildReq({
      cascadeId: "cascade-grep-only-integration",
      modelUid: "MODEL_GREP_ONLY_TEST",
      system:
        `You are Devin.\n<workspace_information>${workspaceRoot}</workspace_information>`,
      messages: [{ role: "user", content: "Find the workspace sentinel." }],
      tools: [
        tool("grep_search"),
        tool("find_by_name"),
        tool("read_file"),
        tool("code_search"),
      ],
      toolChoice: "auto",
    });
    const cascadeResponse = mockResponse();
    const routed = await simulator.Router.route(
      { on: () => {} },
      cascadeResponse,
      request,
      false,
      "MODEL_GREP_ONLY_TEST",
    );
    assert.equal(routed, true);
    assert.equal(
      requestBodies.length,
      2,
      "grep-only interception should execute locally and continue upstream once",
    );
    const firstNames = (requestBodies[0].tools || []).map(
      (entry) => entry.name || (entry.function && entry.function.name),
    );
    assert.equal(firstNames.includes("grep_search"), true);
    assert.equal(firstNames.includes("find_by_name"), true);
    assert.equal(firstNames.includes("read_file"), true);
    assert.equal(firstNames.includes("code_search"), true);
    const localResult = requestBodies[1].input.find(
      (message) => message.type === "function_call_output" && message.call_id === "call_grep_only",
    );
    assert.ok(localResult, "the continuation request must contain the local grep result");
    assert.match(localResult.output, /dao-local-workspace/);
    assert.match(localResult.output, /WorkspaceProbe\.cs/);
    assert.match(localResult.output, /GrepOnlySentinel/);
    assert.equal(
      JSON.stringify(requestBodies[1]).includes("TRANSIENT_STEP_NARRATION_MUST_NOT_REPEAT"),
      false,
      "local Grep retries must not replay transient assistant narration",
    );
    assert.equal(
      requestBodies[1].tools.some((entry) => entry.name === "code_search"),
      true,
      "code_search/Fast Context must remain available",
    );
    assert.equal(
      cascadeResponse.body().includes(Buffer.from("HIDDEN_GREP_ONLY_REASONING")),
      false,
      "internal reasoning must not be emitted to Devin",
    );
    assert.equal(
      cascadeResponse.body().includes(Buffer.from("WorkspaceProbe.cs")),
      false,
      "the local Grep result must stay out of the Devin conversation",
    );
    assert.equal(
      cascadeResponse.body().includes(Buffer.from("GrepOnlySentinel")),
      false,
      "matched source text must be hidden from the conversation",
    );
    assert.equal(
      cascadeResponse.body().includes(Buffer.from("**grep_search**")),
      false,
      "Grep must not add a Markdown summary to the conversation",
    );
    assert.equal(
      cascadeResponse.body().includes(Buffer.from("```text")),
      false,
      "Grep must not add a visible code block to the conversation",
    );
    assert.equal(cascadeResponse.writableEnded, true);

    const followupResponse = mockResponse();
    const followupRequest = simulator.buildReq({
      cascadeId: "cascade-grep-only-integration",
      modelUid: "MODEL_GREP_ONLY_TEST",
      system:
        `You are Devin.\n<workspace_information>${workspaceRoot}</workspace_information>`,
      messages: [
        { role: "user", content: "Find the workspace sentinel." },
        {
          role: "assistant",
          content: "Continue with native Fast Context.",
          tool_calls: [
            {
              id: "call_code_search_after_grep",
              name: "code_search",
              argumentsJson: JSON.stringify({
                search_folder_absolute_uri: workspaceRoot,
                search_term: "registration and navigation",
              }),
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_code_search_after_grep",
          content: "Native Fast Context result.",
        },
      ],
      tools: [
        tool("grep_search"),
        tool("find_by_name"),
        tool("read_file"),
        tool("code_search"),
      ],
      toolChoice: "auto",
    });
    const followupRouted = await simulator.Router.route(
      { on: () => {} },
      followupResponse,
      followupRequest,
      false,
      "MODEL_GREP_ONLY_TEST",
    );
    assert.equal(followupRouted, true);
    assert.equal(
      requestBodies.length,
      3,
      "the next Devin tool-result turn should require only one upstream request",
    );
    const followupInput = requestBodies[2].input || [];
    const grepCallIndex = followupInput.findIndex(
      (message) => message.type === "function_call" && message.call_id === "call_grep_only",
    );
    const grepResultIndex = followupInput.findIndex(
      (message) => message.type === "function_call_output" && message.call_id === "call_grep_only",
    );
    const codeSearchCallIndex = followupInput.findIndex(
      (message) =>
        message.type === "function_call" &&
        message.call_id === "call_code_search_after_grep",
    );
    assert.ok(grepCallIndex >= 0, "the hidden local Grep call must persist across Devin turns");
    assert.ok(grepResultIndex > grepCallIndex, "the persisted local Grep result must follow its call");
    assert.ok(
      codeSearchCallIndex > grepResultIndex,
      "the local Grep trace must be restored before the native Fast Context call",
    );
    assert.match(followupInput[grepResultIndex].output, /GrepOnlySentinel/);
    assert.equal(followupResponse.writableEnded, true);
    console.log("grep-only workspace integration: 25 assertions passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    try {
      fs.unlinkSync(configPath);
    } catch {}
  }
}

async function nativeFastContextPriorityIntegrationTest() {
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "dao-native-fast-context-"),
  );
  const sourcePath = path.join(workspaceRoot, "FastContextSentinel.cs");
  fs.writeFileSync(sourcePath, "public class FastContextSentinel {}\n", "utf8");
  const requestBodies = [];
  const server = http.createServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)) || "{}");
    requestBodies.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (requestBodies.length === 1) {
      const calls = [
        {
          call_id: "local-grep-call",
          name: "grep_search",
          arguments: JSON.stringify({ SearchPath: workspaceRoot, Query: "FastContextSentinel" }),
        },
        {
          call_id: "native-find-call",
          name: "find_by_name",
          arguments: JSON.stringify({
            SearchDirectory: workspaceRoot,
            Pattern: "FastContextSentinel.cs",
          }),
        },
      ];
      calls.forEach((call, index) => {
        response.write(`data:${JSON.stringify({
          type: "response.output_item.added",
          output_index: index,
          item: { type: "function_call", call_id: call.call_id, name: call.name },
        })}\n\n`);
        response.write(`data:${JSON.stringify({
          type: "response.output_item.done",
          output_index: index,
          item: { type: "function_call", ...call },
        })}\n\n`);
      });
      response.write(`data:${JSON.stringify({
        type: "response.completed",
        response: { status: "completed" },
      })}\n\n`);
    } else if (requestBodies.length === 2) {
      response.write(`data:${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "native-fast-context-call", name: "code_search" },
      })}\n\n`);
      response.write(`data:${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "native-fast-context-call",
          name: "code_search",
          arguments: JSON.stringify({
            search_folder_absolute_uri: workspaceRoot,
            search_term: "Find FastContextSentinel",
          }),
        },
      })}\n\n`);
      response.write(`data:${JSON.stringify({
        type: "response.completed",
        response: { status: "completed" },
      })}\n\n`);
    } else {
      response.write(`data:${JSON.stringify({
        type: "response.output_text.delta",
        delta: "Native Fast Context result was received.",
      })}\n\n`);
      response.write(`data:${JSON.stringify({
        type: "response.completed",
        response: { status: "completed" },
      })}\n\n`);
    }
    response.end("data:[DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const configPath = path.join(
    os.tmpdir(),
    `dao-native-fast-context-${process.pid}-${Date.now()}.json`,
  );
  fs.writeFileSync(configPath, JSON.stringify({
    providers: {
      local: {
        enabled: true,
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        completionPath: "/v1/responses",
        noProviderPrefix: true,
        protocol: "openai-responses",
        type: "openai-compatible",
        streamMode: "stream",
      },
    },
    customModels: {
      "native-fast-context-model": {
        id: "native-fast-context-model",
        provider: "local",
        upstreamModel: "native-fast-context-model",
        protocol: "openai-responses",
        contextTokens: 131072,
        maxOutputTokens: 4096,
      },
    },
    daoRoutes: {
      enabled: true,
      routes: {
        MODEL_NATIVE_FAST_CONTEXT_TEST: {
          provider: "local",
          model: "native-fast-context-model",
          sourceProtocol: "openai-responses",
          maxOutputTokens: 4096,
          _customModel: true,
          _customModelId: "native-fast-context-model",
          contextStrategy: { enabled: true, mode: "devin-native", proxyManaged: false },
        },
      },
    },
  }), "utf8");

  try {
    simulator.Router.init({ log: () => {}, configPath });
    const system = `You are Devin.\n<workspace_information>${workspaceRoot}</workspace_information>`;
    const tools = [tool("grep_search"), tool("find_by_name"), tool("read_file"), tool("code_search")];
    const firstResponse = mockResponse();
    const firstRequest = simulator.buildReq({
      cascadeId: "cascade-native-fast-context-priority",
      modelUid: "MODEL_NATIVE_FAST_CONTEXT_TEST",
      system,
      messages: [{ role: "user", content: "Find the sentinel." }],
      tools,
      toolChoice: "auto",
    });
    assert.equal(await simulator.Router.route({ on: () => {} }, firstResponse, firstRequest, false, "MODEL_NATIVE_FAST_CONTEXT_TEST"), true);
    assert.equal(requestBodies.length, 1, "native workspace tools must not wait for a proxy retry");
    assert.equal(firstResponse.body().includes(Buffer.from("find_by_name")), true, "the original response must contain the native file-name search call");
    assert.equal(firstResponse.body().includes(Buffer.from("code_search")), false, "Fast Context must not be invented by a proxy continuation");
    assert.equal(firstResponse.writableEnded, true);

    const secondResponse = mockResponse();
    const secondRequest = simulator.buildReq({
      cascadeId: "cascade-native-fast-context-priority",
      modelUid: "MODEL_NATIVE_FAST_CONTEXT_TEST",
      system,
      messages: [
        { role: "user", content: "Find the sentinel." },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "native-find-call",
            name: "find_by_name",
            argumentsJson: JSON.stringify({ SearchDirectory: workspaceRoot, Pattern: "FastContextSentinel.cs" }),
          }],
        },
        { role: "tool", tool_call_id: "native-find-call", content: sourcePath },
      ],
      tools,
      toolChoice: "auto",
    });
    assert.equal(await simulator.Router.route({ on: () => {} }, secondResponse, secondRequest, false, "MODEL_NATIVE_FAST_CONTEXT_TEST"), true);
    assert.equal(requestBodies.length, 2, "the native file-search result turn must use one normal upstream request");
    assert.equal(secondResponse.body().includes(Buffer.from("code_search")), true, "Fast Context must be emitted in its own Devin-native tool turn");
    const input = requestBodies[1].input || [];
    const nativeCall = input.findIndex((item) => item.type === "function_call" && item.call_id === "native-find-call");
    const nativeResult = input.findIndex((item) => item.type === "function_call_output" && item.call_id === "native-find-call");
    assert.ok(nativeCall >= 0 && nativeResult > nativeCall, "Devin's native file-search pair must be replayed unchanged");
    assert.equal(input.some((item) => item.call_id === "local-grep-call"), false, "devin-native mode must not inject a proxy-owned Grep trace");
    assert.equal(JSON.stringify(input).includes("not executed in proxy retry"), false, "Fast Context must not receive a proxy placeholder result");

    const thirdResponse = mockResponse();
    const thirdRequest = simulator.buildReq({
      cascadeId: "cascade-native-fast-context-priority",
      modelUid: "MODEL_NATIVE_FAST_CONTEXT_TEST",
      system,
      messages: [
        { role: "user", content: "Find the sentinel." },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "native-find-call",
            name: "find_by_name",
            argumentsJson: JSON.stringify({ SearchDirectory: workspaceRoot, Pattern: "FastContextSentinel.cs" }),
          }],
        },
        { role: "tool", tool_call_id: "native-find-call", content: sourcePath },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "native-fast-context-call",
            name: "code_search",
            argumentsJson: JSON.stringify({ search_folder_absolute_uri: workspaceRoot, search_term: "Find FastContextSentinel" }),
          }],
        },
        { role: "tool", tool_call_id: "native-fast-context-call", content: "Fast Context found the sentinel." },
      ],
      tools,
      toolChoice: "auto",
    });
    assert.equal(await simulator.Router.route({ on: () => {} }, thirdResponse, thirdRequest, false, "MODEL_NATIVE_FAST_CONTEXT_TEST"), true);
    assert.equal(requestBodies.length, 3, "the Fast Context result must resume with one normal upstream request");
    const finalInput = requestBodies[2].input || [];
    const finalFastContextCall = finalInput.findIndex((item) => item.type === "function_call" && item.call_id === "native-fast-context-call");
    const finalFastContextResult = finalInput.findIndex((item) => item.type === "function_call_output" && item.call_id === "native-fast-context-call");
    assert.ok(finalFastContextCall >= 0 && finalFastContextResult > finalFastContextCall, "the native Fast Context result must retain a valid Responses tool pair");
    assert.equal(JSON.stringify(requestBodies.slice(0, 2)).includes("not executed in proxy retry"), false, "no proxy continuation may fabricate a native tool result");
    console.log("native Fast Context priority integration: 15 assertions passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    try { fs.unlinkSync(configPath); } catch {}
  }
}

async function emptyResponsesIntegrationTest() {
  async function runCase({ recoverOnRetry, reasoningOnlyFirst }) {
    let requestCount = 0;
    const server = http.createServer(async (request, response) => {
      await readBody(request);
      requestCount += 1;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (reasoningOnlyFirst && requestCount === 1) {
        response.write(
          `data:${JSON.stringify({
            type: "response.reasoning_summary_text.delta",
            delta: "Thinking without any answer.",
          })}\n\n`,
        );
        response.write(
          `data:${JSON.stringify({
            type: "response.completed",
            response: { status: "completed" },
          })}\n\n`,
        );
      }
      if (recoverOnRetry && requestCount === 2) {
        response.write(
          `data:${JSON.stringify({
            type: "response.output_text.delta",
            delta: "Recovered after empty stream.",
          })}\n\n`,
        );
        response.write(
          `data:${JSON.stringify({
            type: "response.completed",
            response: { status: "completed" },
          })}\n\n`,
        );
      }
      response.end("data:[DONE]\n\n");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const configPath = path.join(
      os.tmpdir(),
      `dao-empty-responses-${reasoningOnlyFirst ? "reasoning-" : ""}${recoverOnRetry ? "recover" : "fail"}-${process.pid}-${Date.now()}.json`,
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          local: {
            enabled: true,
            apiKey: "test-key",
            baseUrl: `http://127.0.0.1:${server.address().port}`,
            completionPath: "/v1/responses",
            noProviderPrefix: true,
            protocol: "openai-responses",
            type: "openai-compatible",
            streamMode: "stream",
          },
        },
        customModels: {
          "empty-response-model": {
            id: "empty-response-model",
            provider: "local",
            upstreamModel: "empty-response-model",
            protocol: "openai-responses",
            contextTokens: 131072,
            maxOutputTokens: 4096,
          },
        },
        daoRoutes: {
          enabled: true,
          routes: {
            MODEL_EMPTY_RESPONSE_TEST: {
              provider: "local",
              model: "empty-response-model",
              sourceProtocol: "openai-responses",
              maxOutputTokens: 4096,
              _customModel: true,
              _customModelId: "empty-response-model",
            },
          },
        },
      }),
      "utf8",
    );

    try {
      const initialized = simulator.Router.init({ log: () => {}, configPath });
      assert.equal(initialized.ready, true);
      const cascadeResponse = mockResponse();
      const routed = await simulator.Router.route(
        { on: () => {} },
        cascadeResponse,
        simulator.buildReq({
          cascadeId: `cascade-empty-response-${reasoningOnlyFirst ? "reasoning-" : ""}${recoverOnRetry ? "recover" : "fail"}`,
          modelUid: "MODEL_EMPTY_RESPONSE_TEST",
          system: "You are Devin.",
          messages: [{ role: "user", content: "Return a complete answer." }],
          tools: [tool("code_search")],
          toolChoice: "auto",
        }),
        false,
        "MODEL_EMPTY_RESPONSE_TEST",
      );

      assert.equal(routed, recoverOnRetry);
      assert.equal(requestCount, 2, "an empty Responses stream must be retried exactly once");
      if (recoverOnRetry) {
        assert.equal(cascadeResponse.writableEnded, true);
        assert.equal(
          cascadeResponse.body().includes(Buffer.from("Recovered after empty stream.")),
          true,
          "the retried upstream response must reach Devin",
        );
      } else {
        assert.equal(
          cascadeResponse.writableEnded,
          false,
          "two empty streams must leave the downstream open for the next configured channel",
        );
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      try {
        fs.unlinkSync(configPath);
      } catch {}
    }
  }

  await runCase({ recoverOnRetry: true });
  await runCase({ recoverOnRetry: false });
  await runCase({ recoverOnRetry: true, reasoningOnlyFirst: true });
  console.log("empty Responses integration: 12 assertions passed");
}

integrationTest()
  .then(proactiveGrepOnlyIntegrationTest)
  .then(nativeFastContextPriorityIntegrationTest)
  .then(emptyResponsesIntegrationTest)
  .then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
  );

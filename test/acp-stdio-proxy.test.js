"use strict";

const assert = require("node:assert");
const { once } = require("node:events");
const fs = require("node:fs");
const http2 = require("node:http2");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const WIN = process.platform === "win32";
const ROOT = WIN ? "E:\\新增运行时状态机" : "/tmp/新增运行时状态机";
const WRONG_CWD = WIN ? "C:\\wrong" : "/tmp/wrong";
const proxyPath = path.join(__dirname, "..", "dao-acp-stdio-proxy.js");
const echoChild = path.join(__dirname, "fixtures", "acp-echo-child.js");

function createProtocolMux(httpPort, http2Port) {
  return net.createServer((socket) => {
    socket.once("data", (firstChunk) => {
      const targetPort = firstChunk.subarray(0, 3).toString("ascii") === "PRI"
        ? http2Port
        : httpPort;
      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        upstream.write(firstChunk);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
  });
}

// Default activity file so tests don't pick up the real deployment's state.
const _testActivityFile = path.join(
  os.tmpdir(),
  `dao-acp-activity-test-${process.pid}.json`,
);
fs.writeFileSync(
  _testActivityFile,
  JSON.stringify({ lastActiveAt: Date.now() }),
  "utf8",
);

function runProxy(
  extraTargetArgs = [],
  echoMode = "",
  traceFile = "",
  messages,
  stateFile = "",
  apiServerUrl = "http://127.0.0.1:8937",
  extraEnv = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [proxyPath, process.execPath, echoChild, ...extraTargetArgs],
      {
        env: {
          ...process.env,
          DAO_WORKSPACE_ROOT: ROOT,
          DAO_WORKSPACE_ROOTS: JSON.stringify([ROOT]),
          WINDSURF_API_SERVER_URL: apiServerUrl,
          DAO_DESKTOP_ENDPOINT_FILE:
            extraEnv.DAO_DESKTOP_ENDPOINT_FILE ||
            path.join(
              os.tmpdir(),
              `dao-desktop-endpoint-missing-${process.pid}.json`,
            ),
          DAO_ACP_SUMMARY_ACTIVITY_FILE:
            extraEnv.DAO_ACP_SUMMARY_ACTIVITY_FILE || _testActivityFile,
          ...(echoMode ? { ACP_ECHO_MODE: echoMode } : {}),
          ...(traceFile ? { DAO_ACP_MODEL_TRACE_FILE: traceFile } : {}),
          ...(stateFile ? { DAO_ACP_MODEL_STATE_FILE: stateFile } : {}),
          ...extraEnv,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    const message = Buffer.from(
      (
        messages || [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "session/new",
            params: { cwd: WRONG_CWD, mcpServers: [] },
          },
        ]
      )
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n",
      "utf8",
    );
    for (let index = 0; index < message.length; index += 5) {
      child.stdin.write(message.subarray(index, index + 5));
    }
    child.stdin.end();
  });
}

(async () => {
  const normal = await runProxy();
  assert.equal(normal.code, 0);
  assert.equal(JSON.parse(normal.stdout).params.cwd, ROOT);
  assert.match(normal.stderr, /workspace registered/);

  const summarizer = await runProxy(["--agent-type", "summarizer"]);
  assert.equal(summarizer.code, 0);
  assert.equal(JSON.parse(summarizer.stdout).params.cwd, ROOT);

  const bridgedApi = await runProxy([], "api-url");
  assert.equal(bridgedApi.code, 0);
  assert.match(
    JSON.parse(bridgedApi.stdout).result.apiUrl,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    "each ACP child must use a private loopback session bridge",
  );
  assert.notEqual(
    JSON.parse(bridgedApi.stdout).result.apiUrl,
    "http://127.0.0.1:8937",
    "the ACP child must not connect directly to the shared DAO API",
  );

  const receivedBridgeSessions = [];
  const bridgeUpstream = http2.createServer((req, res) => {
    receivedBridgeSessions.push(req.headers["x-dao-acp-session"] || "");
    res.end("ok");
  });
  bridgeUpstream.listen(0, "127.0.0.1");
  await once(bridgeUpstream, "listening");
  const bridgeUpstreamUrl = `http://127.0.0.1:${bridgeUpstream.address().port}`;
  try {
    const bridgeProbe = await runProxy(
      [],
      "bridge-probe",
      "",
      [
        {
          jsonrpc: "2.0",
          id: 2,
          method: "session/set_config_option",
          params: {
            sessionId: "bridge-session-a",
            configId: "model",
            value: "dao-opus-5",
          },
        },
      ],
      "",
      bridgeUpstreamUrl,
    );
    assert.equal(bridgeProbe.code, 0);
    assert.deepEqual(
      receivedBridgeSessions,
      ["bridge-session-a"],
      "the ACP child must forward its own session identity through its private bridge",
    );

    receivedBridgeSessions.length = 0;
    const promptRouteProbe = await runProxy(
      [],
      "bridge-probe",
      "",
      [
        {
          jsonrpc: "2.0",
          id: 20,
          method: "session/prompt",
          params: { sessionId: "session-a", prompt: [] },
        },
        {
          jsonrpc: "2.0",
          id: 21,
          method: "session/get_config_options",
          params: { sessionId: "session-b" },
        },
      ],
      "",
      bridgeUpstreamUrl,
    );
    assert.equal(promptRouteProbe.code, 0);
    assert.deepEqual(
      receivedBridgeSessions,
      ["session-a", "session-a"],
      "a config read in another session must not overwrite the active ACP inference route",
    );

    receivedBridgeSessions.length = 0;
    const inheritedSessions = [];
    const inheritedUpstream = http2.createServer((req, res) => {
      inheritedSessions.push(req.headers["x-dao-acp-session"] || "");
      res.end("wrong-upstream");
    });
    inheritedUpstream.listen(0, "127.0.0.1");
    await once(inheritedUpstream, "listening");
    let muxPort = 0;
    const healthServer = require("node:http").createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, dao_loaded: true, port: muxPort }));
    });
    healthServer.listen(0, "127.0.0.1");
    await once(healthServer, "listening");
    const mux = createProtocolMux(
      healthServer.address().port,
      bridgeUpstream.address().port,
    );
    mux.listen(0, "127.0.0.1");
    await once(mux, "listening");
    muxPort = mux.address().port;
    const desktopDescriptor = path.join(
      os.tmpdir(),
      `dao-desktop-endpoint-${process.pid}.json`,
    );
    fs.writeFileSync(
      desktopDescriptor,
      JSON.stringify({
        base: `http://127.0.0.1:${muxPort}`,
        host: "127.0.0.1",
        port: muxPort,
      }),
      "utf8",
    );
    try {
      const descriptorProbe = await runProxy(
        [],
        "bridge-probe",
        "",
        [
          {
            jsonrpc: "2.0",
            id: 22,
            method: "session/set_config_option",
            params: {
              sessionId: "desktop-descriptor-session",
              configId: "model",
              value: "dao-opus-5",
            },
          },
        ],
        "",
        `http://127.0.0.1:${inheritedUpstream.address().port}`,
        { DAO_DESKTOP_ENDPOINT_FILE: desktopDescriptor },
      );
      assert.equal(descriptorProbe.code, 0);
      assert.deepEqual(
        receivedBridgeSessions,
        ["desktop-descriptor-session"],
        "a healthy Desktop descriptor must own the next ACP session bridge",
      );
      assert.deepEqual(
        inheritedSessions,
        [],
        "the inherited local endpoint must not win over a healthy Desktop descriptor",
      );
    } finally {
      fs.unlinkSync(desktopDescriptor);
      mux.close();
      healthServer.close();
      inheritedUpstream.close();
      await Promise.all([
        once(mux, "close"),
        once(healthServer, "close"),
        once(inheritedUpstream, "close"),
      ]);
    }
  } finally {
    bridgeUpstream.close();
    await once(bridgeUpstream, "close");
  }

  const lineageDatabase = path.join(
    os.tmpdir(),
    `dao-acp-lineage-${process.pid}.vscdb`,
  );
  const summaryActivityFile = path.join(
    os.tmpdir(),
    `dao-acp-summary-activity-${process.pid}.json`,
  );
  function writeSummaryActivity(lastActiveAt) {
    fs.writeFileSync(
      summaryActivityFile,
      JSON.stringify({ lastActiveAt }),
      "utf8",
    );
  }
  const summaryUpstreamSessions = [];
  const summaryUpstream = http2.createServer((req, res) => {
    summaryUpstreamSessions.push(req.headers["x-dao-acp-session"] || "");
    res.end("ok");
  });
  summaryUpstream.listen(0, "127.0.0.1");
  await once(summaryUpstream, "listening");
  try {
    fs.unlinkSync(lineageDatabase);
  } catch (_) {}
  try {
    require("node:child_process").execFileSync("sqlite3", [
      lineageDatabase,
      "CREATE TABLE ItemTable (key TEXT, value TEXT);",
    ]);
    const lineageKey =
      "windsurf.acp.session/summaryState/acp/devin-cli/primary-space-a";
    const lineageValue = JSON.stringify({
      prefixedSessionId: "acp/summary-agent/summary-space-a",
    });
    require("node:child_process").execFileSync("sqlite3", [
      lineageDatabase,
      `INSERT INTO ItemTable (key, value) VALUES ('${lineageKey}', '${lineageValue.replace(/'/g, "''")}');`,
    ]);
    const summaryMessages = [
      {
        jsonrpc: "2.0",
        id: 11,
        method: "session/new",
        params: { cwd: ROOT, mcpServers: [] },
      },
      {
        jsonrpc: "2.0",
        id: 12,
        method: "session/prompt",
        params: { sessionId: "acp/summary-agent/summary-space-a", prompt: [] },
      },
    ];
    function runSummaryProbe() {
      return runProxy(
        ["--agent-type", "summarizer"],
        "bridge-probe",
        "",
        summaryMessages,
        "",
        `http://127.0.0.1:${summaryUpstream.address().port}`,
        {
          ACP_ECHO_SESSION_ID: "acp/summary-agent/summary-space-a",
          DAO_ACP_GLOBAL_STORAGE_DB: lineageDatabase,
          DAO_ACP_SUMMARY_ACTIVITY_FILE: summaryActivityFile,
        },
      );
    }

    // 主 session 刚活动过 → 摘要仍转发, 但不得继承主 session 的模型路由
    writeSummaryActivity(Date.now());
    const summaryProbe = await runSummaryProbe();
    assert.equal(summaryProbe.code, 0);
    assert.deepEqual(
      summaryUpstreamSessions,
      [""],
      "summary agents must not inherit the main session's model route (cost isolation)",
    );

    // 主 session 冷却超时 → 摘要请求不得抵达上游(省钱闸门)
    summaryUpstreamSessions.length = 0;
    writeSummaryActivity(Date.now() - 10 * 60 * 1000);
    const coldProbe = await runSummaryProbe();
    assert.equal(coldProbe.code, 0);
    assert.deepEqual(
      summaryUpstreamSessions,
      [],
      "an idle main session must stop summary traffic from reaching upstream",
    );

    // 从未记录过活动 = 无活动, 亦须冷却(否则闸门永不可达)
    summaryUpstreamSessions.length = 0;
    try {
      fs.unlinkSync(summaryActivityFile);
    } catch (_) {}
    const neverActiveProbe = await runSummaryProbe();
    assert.equal(neverActiveProbe.code, 0);
    assert.deepEqual(
      summaryUpstreamSessions,
      [],
      "a missing activity record must count as idle, not as fresh activity",
    );
  } finally {
    summaryUpstream.close();
    await once(summaryUpstream, "close");
    try {
      fs.unlinkSync(lineageDatabase);
    } catch (_) {}
    try {
      fs.unlinkSync(summaryActivityFile);
    } catch (_) {}
  }

  const traceFile = path.join(
    os.tmpdir(),
    `dao-acp-model-trace-${process.pid}.jsonl`,
  );
  try {
    const modelInput =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: ROOT, mcpServers: [] },
      }) + "\n";
    const traced = await runProxy([], "models", traceFile);
    assert.equal(traced.code, 0);
    const tracedResponse = JSON.parse(traced.stdout);
    assert.equal(tracedResponse.result.models.currentModelId, "dao-opus-5");
    const availableModelIds = JSON.parse(
      fs.readFileSync(traceFile, "utf8"),
    ).availableModels.map((model) => model.modelId);
    assert.equal(
      availableModelIds.includes("swe-1-6-slow"),
      true,
      "model catalog injection must preserve the ACP-compatible mount model",
    );
    assert.equal(
      availableModelIds.includes("dao-glm-5-2"),
      true,
      "model catalog injection must expose Dao models to the native ACP picker",
    );

    const configOptions = await runProxy([], "config-options");
    assert.equal(configOptions.code, 0);
    const configResponse = JSON.parse(configOptions.stdout);
    const modelOption = configResponse.result.configOptions.find(
      (option) => option.category === "model",
    );
    assert.deepEqual(
      modelOption.options.filter((group) => group.group.startsWith("dao-")),
      [
        {
          group: "dao-opus-5",
          name: "Dao Opus 5",
          options: [{ value: "dao-opus-5", name: "Dao Opus 5" }],
        },
        {
          group: "dao-opus-4-8",
          name: "Dao Opus 4.8",
          options: [{ value: "dao-opus-4-8", name: "Dao Opus 4.8" }],
        },
        {
          group: "dao-gpt-5-6-sol",
          name: "Dao GPT-5.6 Sol",
          options: [{ value: "dao-gpt-5-6-sol", name: "Dao GPT-5.6 Sol" }],
        },
        {
          group: "dao-gpt-5-6-terra",
          name: "Dao GPT-5.6 Terra",
          options: [{ value: "dao-gpt-5-6-terra", name: "Dao GPT-5.6 Terra" }],
        },
        {
          group: "dao-gpt-5-6-luna",
          name: "Dao GPT-5.6 Luna",
          options: [{ value: "dao-gpt-5-6-luna", name: "Dao GPT-5.6 Luna" }],
        },
        {
          group: "dao-fable-5",
          name: "Dao Fable 5",
          options: [{ value: "dao-fable-5", name: "Dao Fable 5" }],
        },
        {
          group: "dao-glm-5-2",
          name: "Dao GLM 5.2",
          options: [{ value: "dao-glm-5-2", name: "Dao GLM 5.2" }],
        },
        {
          group: "dao-mimo-v2-5",
          name: "Dao MiMo v2.5",
          options: [{ value: "dao-mimo-v2-5", name: "Dao MiMo v2.5" }],
        },
      ],
      "ACP model selector options must expose every Dao model as a searchable native-style group",
    );
    assert.deepEqual(
      configResponse.result.configOptions.find(
        (option) => option.id === "mode",
      ),
      {
        id: "mode",
        category: "agent",
        name: "Mode",
        value: { currentValue: "default", options: [] },
      },
      "non-model ACP config options must remain unchanged",
    );

    const invalidConfigOptions = await runProxy([], "invalid-config-options");
    assert.equal(invalidConfigOptions.code, 0);
    const invalidModelOption = JSON.parse(
      invalidConfigOptions.stdout,
    ).result.configOptions.find((option) => option.category === "model");
    assert.deepEqual(
      invalidModelOption.options
        .filter((group) => group.group.startsWith("dao-"))
        .map((group) => group.options[0].value),
      [
        "dao-opus-5",
        "dao-opus-4-8",
        "dao-gpt-5-6-sol",
        "dao-gpt-5-6-terra",
        "dao-gpt-5-6-luna",
        "dao-fable-5",
        "dao-glm-5-2",
        "dao-mimo-v2-5",
      ],
      "invalid ACP model options must still expose each Dao model as a searchable group",
    );

    const stateFile = path.join(
      os.tmpdir(),
      `dao-acp-model-state-${process.pid}.json`,
    );
    try {
      const switched = await runProxy(
        [],
        "model-switch",
        "",
        [
          {
            jsonrpc: "2.0",
            id: 3,
            method: "session/set_config_option",
            params: {
              sessionId: "dao-test-session",
              configId: "model",
              value: "dao-gpt-5-6-terra",
            },
          },
        ],
        stateFile,
      );
      assert.equal(switched.code, 0);
      const switchResponse = JSON.parse(switched.stdout);
      assert.equal(
        switchResponse.result.receivedModel,
        "swe-1-6-slow",
        "Dao model switches must use the ACP-compatible mount model",
      );
      assert.equal(
        switchResponse.result.configOptions[0].currentValue,
        "dao-gpt-5-6-terra",
        "Dao model switches must retain the requested UI model identity",
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(stateFile, "utf8")).sessions,
        {
          "dao-test-session": "dao-gpt-5-6-terra",
        },
      );

      const nativeSwitched = await runProxy(
        [],
        "native-model-switch",
        "",
        [
          {
            jsonrpc: "2.0",
            id: 30,
            method: "session/set_model",
            params: {
              sessionId: "dao-native-model-session",
              modelId: "dao-glm-5-2",
            },
          },
        ],
        stateFile,
      );
      assert.equal(nativeSwitched.code, 0);
      const nativeLines = nativeSwitched.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const nativeNotification = nativeLines.find(
        (message) =>
          message.method === "session/update" &&
          message.params &&
          message.params.update &&
          message.params.update.sessionUpdate === "config_option_update",
      );
      assert.equal(
        nativeNotification &&
          nativeNotification.params.update.configOptions.find(
            (option) => option.id === "model",
          ).currentValue,
        "dao-glm-5-2",
        "agent config_option_update notifications must echo the Dao model, not the mount model",
      );
      const nativeSwitchResponse = nativeLines.find(
        (message) => message.id === 30,
      );
      assert.equal(
        nativeSwitchResponse.result.receivedModel,
        "swe-1-6-slow",
        "native ACP model switches must use the ACP-compatible mount model",
      );
      assert.equal(
        nativeSwitchResponse.result.models.currentModelId,
        "dao-glm-5-2",
        "native ACP model switches must retain the requested UI model identity",
      );
      assert.equal(
        nativeSwitchResponse.result.models.availableModels.some(
          (model) => model.modelId === "dao-glm-5-2",
        ),
        true,
        "native ACP model switches must expose the selected Dao model in the model catalog",
      );
      assert.equal(
        JSON.parse(fs.readFileSync(stateFile, "utf8")).sessions[
          "dao-native-model-session"
        ],
        "dao-glm-5-2",
        "native ACP model switches must persist the selection for the ACP session",
      );

      const isolated = await runProxy(
        [],
        "model-session-isolation",
        "",
        [
          {
            jsonrpc: "2.0",
            id: 4,
            method: "session/set_config_option",
            params: {
              sessionId: "session-a",
              configId: "model",
              value: "dao-gpt-5-6-terra",
            },
          },
          {
            jsonrpc: "2.0",
            id: 5,
            method: "session/get_config_options",
            params: { sessionId: "session-b" },
          },
        ],
        stateFile,
      );
      assert.equal(isolated.code, 0);
      const [sessionAResponse, sessionBResponse] = isolated.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        sessionAResponse.result.configOptions[0].currentValue,
        "dao-gpt-5-6-terra",
        "the session that selected a Dao model must retain its own UI model identity",
      );
      assert.equal(
        sessionBResponse.result.configOptions[0].currentValue ||
          sessionBResponse.result.configOptions[0].value.currentValue,
        "",
        "a Dao model selection in session A must not change session B",
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(stateFile, "utf8")).sessions,
        {
          "dao-test-session": "dao-gpt-5-6-terra",
          "dao-native-model-session": "dao-glm-5-2",
          "session-a": "dao-gpt-5-6-terra",
        },
      );

      const refreshed = await runProxy(
        [],
        "model-session-isolation",
        "",
        [
          {
            jsonrpc: "2.0",
            id: 6,
            method: "session/set_config_option",
            params: {
              sessionId: "session-c",
              configId: "model",
              value: "dao-gpt-5-6-luna",
            },
          },
          {
            jsonrpc: "2.0",
            id: 7,
            method: "session/get_config_options",
            params: { sessionId: "session-c" },
          },
        ],
        stateFile,
      );
      assert.equal(refreshed.code, 0);
      const [, refreshedResponse] = refreshed.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        refreshedResponse.result.configOptions[0].currentValue,
        "dao-gpt-5-6-luna",
        "a later config read in the same session must retain the selected Dao model",
      );

      // session/new 的请求 params 无 sessionId — id 只在响应 result 里。
      // 若响应归属只看 requestSessions, 新会话的 configOptions 无从归属,
      // 选择器就回退成 Devin 自己的挂载模型 swe-1-6-slow(用户所见"自动切回 swe")。
      fs.writeFileSync(
        stateFile,
        JSON.stringify({
          sessions: { "new-space-a": "dao-opus-4-8" },
          updatedAt: Date.now(),
        }),
        "utf8",
      );
      const resumed = await runProxy(
        [],
        "session-new-config",
        "",
        [
          {
            jsonrpc: "2.0",
            id: 8,
            method: "session/new",
            params: { cwd: ROOT, mcpServers: [] },
          },
        ],
        stateFile,
        "http://127.0.0.1:8937",
        { ACP_ECHO_SESSION_ID: "new-space-a" },
      );
      assert.equal(resumed.code, 0);
      const resumedOption = JSON.parse(resumed.stdout.trim().split("\n").pop())
        .result.configOptions[0];
      assert.equal(
        resumedOption.currentValue,
        "dao-opus-4-8",
        "a new session must keep its own BYOK model instead of falling back to swe-1-6-slow",
      );
    } finally {
      try {
        fs.unlinkSync(stateFile);
      } catch (_) {}
    }
  } finally {
    try {
      fs.unlinkSync(traceFile);
    } catch (_) {
      // The fixture may not create a trace when the child fails early.
    }
  }

  // ── 摘要冷却 · 整条运行时链路 ──
  // 单元层直接注入 shouldBlock 测不到「摘要模式下真起 proxy」这条路径: 冷却判定在
  // proxy, 闸门在桥, 两者由 launch() 串起。此处以真 proxy + 真桥 + stub 上游实测,
  // 同时钉住两条实证之病:
  //   ① 闸门一律拦 h2c 全流 → 鉴权被吞 → "Failed to activate agent"
  //   ② 短路不带 trailers → 客户端等 grpc-status 到 10s 超时
  const cooldownPaths = [];
  const cooldownUpstream = http2.createServer((req, res) => {
    cooldownPaths.push(req.url || "");
    res.end("upstream-ok");
  });
  const cooldownSessions = new Set();
  cooldownUpstream.on("session", (session) => {
    cooldownSessions.add(session);
    session.once("close", () => cooldownSessions.delete(session));
  });
  cooldownUpstream.listen(0, "127.0.0.1");
  await once(cooldownUpstream, "listening");
  const cooldownUpstreamUrl = `http://127.0.0.1:${cooldownUpstream.address().port}`;
  const activityFile = path.join(
    os.tmpdir(),
    `dao-acp-activity-${process.pid}.json`,
  );
  const probeMessage = [
    {
      jsonrpc: "2.0",
      id: 9,
      method: "session/prompt",
      params: { sessionId: "summary-probe" },
    },
  ];
  const runCooldownProbe = async (lastActiveAt) => {
    fs.writeFileSync(activityFile, JSON.stringify({ lastActiveAt }), "utf8");
    cooldownPaths.length = 0;
    const run = await runProxy(
      ["--agent-type", "summarizer"],
      "cooldown-probe",
      "",
      probeMessage,
      "",
      cooldownUpstreamUrl,
      {
        DAO_ACP_SUMMARY_ACTIVITY_FILE: activityFile,
        DAO_ACP_SUMMARY_COOLDOWN_MS: "60000",
      },
    );
    assert.equal(
      run.code,
      0,
      `summarizer proxy must exit cleanly: ${run.stderr}`,
    );
    const probes = JSON.parse(run.stdout.trim().split("\n").pop()).result
      .probes;
    const byRpc = (name) => probes.find((probe) => probe.path.endsWith(name));
    return {
      inference: byRpc("GetChatMessage"),
      auth: byRpc("GetCliTeamSettings"),
      reached: [...cooldownPaths],
    };
  };
  try {
    const cold = await runCooldownProbe(Date.now() - 10 * 60 * 1000);
    assert.equal(
      cold.inference.hung,
      false,
      "a gated inference stream must answer immediately, never hang until the client times out",
    );
    assert.equal(
      cold.inference.grpcStatus,
      "8",
      "a short-circuited gRPC stream must carry trailers so the client stops waiting for grpc-status",
    );
    assert.equal(
      cold.auth.status,
      200,
      "the cooldown gate must never block authentication, or Devin cannot activate",
    );
    assert.equal(cold.auth.body, "upstream-ok");
    assert.deepEqual(
      cold.reached,
      ["/exabeam.api.v1.SeatManagementService/GetCliTeamSettings"],
      "while cold, only authentication may reach upstream",
    );

    const hot = await runCooldownProbe(Date.now());
    assert.equal(
      hot.inference.body,
      "upstream-ok",
      "while the main session is hot, summary inference must be forwarded",
    );
    assert.deepEqual(
      hot.reached.map((requestPath) => requestPath.split("/").pop()).sort(),
      ["GetChatMessage", "GetCliTeamSettings"],
      "a hot main session must let both inference and authentication through",
    );
  } finally {
    try {
      fs.unlinkSync(activityFile);
    } catch (_) {}
    for (const session of cooldownSessions) session.destroy();
    await new Promise((resolve) => cooldownUpstream.close(resolve));
  }

  console.log("acp stdio proxy selftest: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

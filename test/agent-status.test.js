"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentHudController } = require("../core/agent_hud.js");
const { stateDir } = require("../core/product_identity");

const originalHome = process.env.HOME;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-agent-status-"));
process.env.HOME = tempHome;

function cfg(mode = "on") {
  return {
    daoRoutes: {
      agentStatus: { enabled: true, defaultMode: mode, profile: "auto", softRules: true },
    },
  };
}

function toolTurn(id, name, args, result, isError = false) {
  return [
    {
      role: "assistant",
      tool_calls: [
        { id, function: { name, arguments: JSON.stringify(args || {}) } },
      ],
    },
    {
      role: "tool",
      tool_call_id: id,
      content: result,
      tool_result_is_error: isError,
    },
  ];
}

try {
  const status = require("../vendor/外接api/core/agent_status.js");

  const first = status.prepareOutbound({
    key: "dao:baseline-a",
    identityKind: "native",
    messages: [{ role: "user", content: "修复支付测试" }],
    modelUid: "swe-1-6-slow",
    provider: "ay",
    upstreamModel: "gpt-5.6-terra",
    workspaceRoots: [tempHome],
    cfg: cfg("on"),
  });
  assert.strictEqual(first.injected, true);
  assert.match(first.messages.at(-1).content, /<agent_status/);
  assert.match(first.messages.at(-1).content, /model_uid: swe-1-6-slow/);

  const cacheFriendlyCfg = cfg("on");
  const cacheFriendlyFirst = status.prepareOutbound({
    key: "dao:cache-friendly",
    identityKind: "native",
    messages: [{ role: "user", content: "保持同一会话缓存前缀" }],
    modelUid: "dao-opus-5",
    provider: "cccc",
    upstreamModel: "claude-opus-5",
    injectOutbound: false,
    cfg: cacheFriendlyCfg,
  });
  assert.strictEqual(cacheFriendlyFirst.injected, false);
  assert.doesNotMatch(JSON.stringify(cacheFriendlyFirst.messages), /dao-agent-status/);
  assert.strictEqual(cacheFriendlyFirst.state.activity.requestInFlight, true);
  assert.strictEqual(status.summary("dao:cache-friendly").route.provider, "cccc");

  const cacheFriendlySecond = status.prepareOutbound({
    key: "dao:cache-friendly",
    identityKind: "native",
    messages: [
      ...cacheFriendlyFirst.messages,
      { role: "assistant", content: "继续" },
      { role: "user", content: "下一轮" },
    ],
    injectOutbound: false,
    cfg: cacheFriendlyCfg,
  });
  assert.strictEqual(cacheFriendlySecond.injected, false);
  assert.deepStrictEqual(
    cacheFriendlySecond.messages.slice(0, cacheFriendlyFirst.messages.length),
    cacheFriendlyFirst.messages,
    "disabling outbound status injection must preserve an append-only prefix",
  );
  assert.doesNotMatch(JSON.stringify(cacheFriendlySecond.messages), /dao-agent-status/);

  const second = status.prepareOutbound({
    key: "dao:baseline-a",
    identityKind: "native",
    messages: [...first.messages, { role: "assistant", content: "继续" }],
    cfg: cfg("on"),
  });
  assert.strictEqual(
    second.messages.filter((message) =>
      String(message.content || "").includes("<agent_status"),
    ).length,
    1,
  );
  assert.strictEqual(second.messages.at(-1)._daoAgentStatus, true);

  let now = 1_000_000;
  status._test.setNow(() => now);

  const short = status.prepareOutbound({
    key: "dao:short",
    identityKind: "native",
    messages: [{ role: "user", content: "解释这行代码" }],
    cfg: cfg("auto"),
  });
  assert.strictEqual(short.injected, false);
  assert.strictEqual(status.summary("dao:short").activation.state, "dormant");

  let longMessages = [{ role: "user", content: "调查并修复错误" }];
  for (let index = 1; index <= 3; index += 1) {
    longMessages.push(
      ...toolTurn(
        `tool-${index}`,
        "read_file",
        { path: `f${index}.js` },
        "ok",
      ),
    );
  }
  const activated = status.prepareOutbound({
    key: "dao:auto-tools",
    identityKind: "native",
    messages: longMessages,
    cfg: cfg("auto"),
  });
  assert.strictEqual(activated.injected, true);
  assert.strictEqual(activated.state.activation.reason, "tools");

  const customThresholdCfg = cfg("auto");
  customThresholdCfg.daoRoutes.agentStatus.auto = { minToolCalls: 2 };
  const customThreshold = status.prepareOutbound({
    key: "dao:auto-custom-threshold",
    identityKind: "native",
    messages: [
      { role: "user", content: "调查两个文件" },
      ...toolTurn("custom-1", "read_file", { path: "one.js" }, "ok"),
      ...toolTurn("custom-2", "read_file", { path: "two.js" }, "ok"),
    ],
    cfg: customThresholdCfg,
  });
  assert.strictEqual(customThreshold.state.activation.reason, "tools");

  const stillActive = status.prepareOutbound({
    key: "dao:auto-tools",
    identityKind: "native",
    messages: [{ role: "user", content: "谢谢" }],
    cfg: cfg("auto"),
  });
  assert.strictEqual(stillActive.injected, true);
  assert.strictEqual(stillActive.state.activation.state, "active");
  assert.strictEqual(stillActive.state.activation.reason, "tools");

  const editActivated = status.prepareOutbound({
    key: "dao:auto-edit",
    identityKind: "native",
    messages: [
      { role: "user", content: "改一下文案" },
      ...toolTurn("edit-1", "edit", { path: "README.md" }, "ok"),
    ],
    cfg: cfg("auto"),
  });
  assert.strictEqual(editActivated.injected, true);
  assert.strictEqual(editActivated.state.activation.reason, "edit");

  const todoActivated = status.prepareOutbound({
    key: "dao:auto-todo",
    identityKind: "native",
    messages: [
      { role: "user", content: "完成任务" },
      ...toolTurn(
        "todo-1",
        "TodoWrite",
        { todos: [{ id: "one", content: "未完成", status: "pending" }] },
        "ok",
      ),
    ],
    cfg: cfg("auto"),
  });
  assert.strictEqual(todoActivated.state.activation.reason, "todo");

  const testActivated = status.prepareOutbound({
    key: "dao:auto-test",
    identityKind: "native",
    messages: [
      { role: "user", content: "跑测试" },
      ...toolTurn("test-1", "run_tests", {}, "all tests passed"),
    ],
    cfg: cfg("auto"),
  });
  // activation.reason === "test" 仍由「命令看起来像跑测试」触发（激活时机判断，
  // 不产生对错结论），保留。但 verification 段已在 A 阶段整段删除——
  // 它的值来自解析工具输出的自由文本，五次误判后证明这个取数方式不可靠。
  assert.strictEqual(testActivated.state.activation.reason, "test");
  assert.strictEqual(testActivated.state.verification, undefined);

  const testFailure = status.prepareOutbound({
    key: "dao:test-recovery",
    identityKind: "native",
    messages: [
      { role: "user", content: "修复测试" },
      ...toolTurn("test-failed", "run_tests", {}, "1 failed, 9 passed"),
    ],
    cfg: cfg("auto"),
  });
  // 原本这里验证「失败 → verificationBlocking=true → 再跑绿 → 翻回 false」
  // 这条状态机。A 阶段把 verification 段与 verificationBlocking 一起删除：
  // 它们的输入是工具输出的自由文本，五次误判后证明这个取数方式不可靠。
  // B 阶段会用带外结构化信号（退出码 / --junitxml / --json）重建。
  assert.strictEqual(testFailure.state.verification, undefined);
  assert.strictEqual(testFailure.state.conclusions.verificationBlocking, undefined);
  const testRecovered = status.prepareOutbound({
    key: "dao:test-recovery",
    identityKind: "native",
    messages: [
      { role: "user", content: "修复测试" },
      ...toolTurn("test-failed", "run_tests", {}, "1 failed, 9 passed"),
      ...toolTurn("test-passed", "run_tests", {}, "10 passed, 0 failed"),
    ],
    cfg: cfg("auto"),
  });
  // 执行层计数仍然正常累加（两轮工具调用），它来自计数器而非文本解析
  assert.strictEqual(testRecovered.state.execution.totalToolCalls, 2);
  assert.strictEqual(testRecovered.state.verification, undefined);

  const terminalActivated = status.prepareOutbound({
    key: "dao:auto-terminal",
    identityKind: "native",
    messages: [
      { role: "user", content: "检查命令" },
      ...toolTurn("terminal-1", "exec_command", { cmd: "pwd" }, "ok"),
    ],
    cfg: cfg("auto"),
  });
  assert.strictEqual(terminalActivated.state.activation.reason, "terminal");

  const failureActivated = status.prepareOutbound({
    key: "dao:auto-failure",
    identityKind: "native",
    messages: [
      { role: "user", content: "检查文件" },
      ...toolTurn(
        "failure-1",
        "read_file",
        { path: "missing" },
        "ENOENT: missing",
        true,
      ),
    ],
    cfg: cfg("auto"),
  });
  assert.strictEqual(failureActivated.state.activation.reason, "failure");

  const recoveredFailureActivated = status.prepareOutbound({
    key: "dao:auto-recovered-failure",
    identityKind: "native",
    messages: [
      { role: "user", content: "重试读取文件" },
      ...toolTurn(
        "recovered-failure-1",
        "read_file",
        { path: "missing" },
        "ENOENT: missing",
        true,
      ),
      ...toolTurn(
        "recovered-failure-2",
        "read_file",
        { path: "present" },
        "ok",
      ),
    ],
    cfg: cfg("auto"),
  });
  assert.strictEqual(recoveredFailureActivated.state.execution.totalToolCalls, 2);
  assert.strictEqual(recoveredFailureActivated.state.activation.reason, "failure");
  assert.strictEqual(recoveredFailureActivated.injected, true);

  status.setMode("dao:auto-edit", "off", cfg("auto"));
  const disabledBefore = status.summary("dao:auto-edit");
  const disabledUpdates = [];
  const disabledSubscription = status.onDidUpdate((value) => {
    if (value.key === "dao:auto-edit") disabledUpdates.push(value);
  });
  const disabled = status.prepareOutbound({
    key: "dao:auto-edit",
    identityKind: "native",
    messages: [
      ...editActivated.messages,
      { role: "user", content: "this turn must not be observed" },
      ...toolTurn(
        "disabled-new-tool",
        "read_file",
        { path: "disabled.js" },
        "ok",
      ),
    ],
    modelUid: "disabled-model",
    provider: "disabled-provider",
    upstreamModel: "disabled-upstream",
    cfg: cfg("auto"),
  });
  disabledSubscription.dispose();
  assert.strictEqual(disabled.injected, false);
  assert.strictEqual(disabled.state, null);
  assert.strictEqual(
    disabled.messages.some((message) =>
      String(message.content || "").includes("<agent_status"),
    ),
    false,
  );
  assert.deepStrictEqual(
    status.summary("dao:auto-edit"),
    disabledBefore,
    "Off sessions must not count tools, update route/activity, or emit a new state",
  );
  assert.deepStrictEqual(
    disabledUpdates,
    [disabledBefore],
    "Off sessions should rebroadcast their unchanged summary so the HUD can turn them back On",
  );

  const offReplayHud = createAgentHudController({
    now: () => now,
    activeTtlMs: 1_000,
    staleTtlMs: 1_000,
  });
  assert.strictEqual(offReplayHud.update(disabledBefore), true);
  now += 1_001;
  offReplayHud.prune();
  assert.strictEqual(offReplayHud.list().length, 0);
  const offReplaySubscription = status.onDidUpdate((value) => {
    if (value.key === "dao:auto-edit") offReplayHud.update(value);
  });
  status.prepareOutbound({
    key: "dao:auto-edit",
    messages: [{ role: "user", content: "discover this disabled session" }],
    cfg: cfg("auto"),
  });
  offReplaySubscription.dispose();
  assert.strictEqual(offReplayHud.list().length, 1);
  assert.strictEqual(offReplayHud.list()[0].mode, "off");

  status.setMode("dao:auto-edit", "on", cfg("auto"));
  assert.strictEqual(status.summary("dao:auto-edit").activation.state, "active");

  const durationMessages = [{ role: "user", content: "分析问题" }];
  status.prepareOutbound({
    key: "dao:auto-duration",
    identityKind: "native",
    messages: durationMessages,
    cfg: cfg("auto"),
  });
  now += 90_001;
  const durationActivated = status.prepareOutbound({
    key: "dao:auto-duration",
    identityKind: "native",
    messages: [...durationMessages, { role: "assistant", content: "分析中" }],
    cfg: cfg("auto"),
  });
  assert.strictEqual(durationActivated.state.activation.reason, "duration");

  const isolationA = status.prepareOutbound({
    key: "dao:isolation-a",
    identityKind: "native",
    messages: [
      { role: "user", content: "A" },
      ...toolTurn("isolation-1", "exec_command", { cmd: "pwd" }, "ok"),
    ],
    cfg: cfg("auto"),
  });
  const isolationB = status.prepareOutbound({
    key: "dao:isolation-b",
    identityKind: "derived",
    messages: [{ role: "user", content: "B" }],
    cfg: cfg("on"),
  });
  status.setMode("dao:isolation-a", "off", cfg("auto"));
  status.recordRoute("dao:isolation-a", {
    provider: "ay",
    upstreamModel: "gpt-5.6-terra",
  });
  status.recordRoute("dao:isolation-b", {
    provider: "glm",
    upstreamModel: "glm-5.2",
  });
  assert.strictEqual(isolationA.state.execution.totalToolCalls, 1);
  assert.strictEqual(isolationB.state.execution.totalToolCalls, 0);
  assert.strictEqual(status.summary("dao:isolation-a").mode, "off");
  assert.strictEqual(status.summary("dao:isolation-b").mode, "on");
  assert.strictEqual(status.summary("dao:isolation-a").route.provider, "ay");
  assert.strictEqual(status.summary("dao:isolation-b").route.provider, "glm");

  const invalidMode = status.setMode("dao:invalid-mode", "sometimes", cfg("on"));
  assert.strictEqual(invalidMode.mode, "auto");
  assert.strictEqual(invalidMode.activation.state, "dormant");

  const listenerUpdates = [];
  const throwingSubscription = status.onDidUpdate(() => {
    throw new Error("listener failure");
  });
  const healthySubscription = status.onDidUpdate((value) =>
    listenerUpdates.push(value),
  );
  status.onDidUpdate(null).dispose();
  status.setMode("dao:listener", "on", cfg("auto"));
  throwingSubscription.dispose();
  healthySubscription.dispose();
  assert.strictEqual(listenerUpdates.at(-1).key, "dao:listener");

  assert.deepStrictEqual(
    status.options({
      daoRoutes: {
        agentStatus: {
          enabled: false,
          defaultMode: "invalid",
          auto: { minToolCalls: -2, activateAfterMs: 12 },
          hud: {
            enabled: false,
            activeTtlMs: -1,
            staleTtlMs: 0,
          },
        },
      },
    }),
    {
      enabled: false,
      defaultMode: "auto",
      auto: { minToolCalls: 1, activateAfterMs: 1_000 },
      hud: { enabled: false, activeTtlMs: 1_000, staleTtlMs: 7_200_000 },
    },
  );

  const safeResult = status.prepareOutbound({
    key: "dao:safe-summary",
    identityKind: "native",
    identityId: "safe-id",
    messages: [
      { role: "user", content: "safe   goal" },
      ...toolTurn(
        "safe-1",
        "read_file",
        { path: "/private/secret-input.js" },
        "super-secret-tool-output",
      ),
    ],
    workspaceRoots: [path.join(tempHome, "private", "workspace-name")],
    cfg: cfg("on"),
  });
  assert.strictEqual(safeResult.injected, true);
  const safeSummary = status.summary("dao:safe-summary");
  assert.deepStrictEqual(Object.keys(safeSummary).sort(), [
    "activation",
    "activity",
    "failures",
    "goal",
    "identity",
    "key",
    "mode",
    "observedAt",
    "phase",
    "route",
    "todo",
    "updatedAt",
    // "verification" 已在 A 阶段从 summary 里移除（详见实现处长注释）
    "version",
    "workspace",
  ]);
  assert.strictEqual(safeSummary.goal, "safe goal");
  assert.strictEqual(safeSummary.workspace, "workspace-name");
  assert.strictEqual(safeSummary.identity.id, "safe-id");
  assert.doesNotMatch(JSON.stringify(safeSummary), /secret|private/);

  const provisional = status.prepareOutbound({
    key: "dao:route-lifecycle",
    identityKind: "native",
    messages: [{ role: "user", content: "route" }],
    provider: "ay",
    upstreamModel: "provisional-model",
    cfg: cfg("on"),
  });
  assert.strictEqual(provisional.state.activity.requestInFlight, true);
  assert.strictEqual(provisional.state.route.provisional, true);
  const routeHud = createAgentHudController({ now: () => now });
  assert.strictEqual(routeHud.update(status.summary("dao:route-lifecycle")), true);
  const provisionalVersion = provisional.state.version;
  const actualRoute = status.recordRoute("dao:route-lifecycle", {
    provider: "glm",
    upstreamModel: "actual-model",
  });
  assert.strictEqual(actualRoute.version, provisionalVersion + 1);
  assert.strictEqual(
    routeHud.update(actualRoute),
    true,
    "actual route must supersede a provisional update in the same millisecond",
  );
  assert.match(routeHud.project().dao.text, /→glm/);
  assert.doesNotMatch(routeHud.project().dao.text, /→…/);
  assert.strictEqual(status.summary("dao:route-lifecycle").route.provisional, false);
  assert.strictEqual(status.summary("dao:route-lifecycle").activity.requestInFlight, false);
  const finished = status.finishRequest("dao:route-lifecycle");
  assert.strictEqual(finished.version, actualRoute.version + 1);
  assert.strictEqual(finished.route.provider, "glm");

  const beforeModeVersion = status.summary("dao:route-lifecycle").version;
  const modeUpdate = status.setMode("dao:route-lifecycle", "off", cfg("auto"));
  assert.strictEqual(modeUpdate.version, beforeModeVersion + 1);

  status.prepareOutbound({
    key: "dao:route-change",
    messages: [{ role: "user", content: "first route" }],
    modelUid: "model-a",
    provider: "provider-a-candidate",
    upstreamModel: "upstream-a-candidate",
    cfg: cfg("on"),
  });
  status.recordRoute("dao:route-change", {
    modelUid: "model-a",
    provider: "provider-a",
    upstreamModel: "upstream-a",
  });
  const changedRoute = status.prepareOutbound({
    key: "dao:route-change",
    messages: [{ role: "user", content: "changed route" }],
    modelUid: "model-b",
    cfg: cfg("on"),
  });
  assert.deepStrictEqual(changedRoute.state.route, {
    modelUid: "model-b",
    provider: "",
    upstreamModel: "",
    provisional: true,
  });
  assert.deepStrictEqual(status.finishRequest("dao:route-change").route, {
    modelUid: "model-b",
    provider: "",
    upstreamModel: "",
    provisional: true,
  });

  status.recordRoute("dao:route-same-model", {
    modelUid: "model-a",
    provider: "provider-a",
    upstreamModel: "upstream-a",
  });
  const sameRoute = status.prepareOutbound({
    key: "dao:route-same-model",
    messages: [{ role: "user", content: "same route" }],
    modelUid: "model-a",
    provider: "provider-candidate",
    upstreamModel: "upstream-candidate",
    cfg: cfg("on"),
  });
  assert.deepStrictEqual(sameRoute.state.route, {
    modelUid: "model-a",
    provider: "provider-a",
    upstreamModel: "upstream-a",
    provisional: false,
  });

  let isolatedListenerRoute;
  const mutatingRouteSubscription = status.onDidUpdate((summary) => {
    if (summary.key === "dao:sanitized-route") {
      summary.route.provider = "mutated-provider";
    }
  });
  const observingRouteSubscription = status.onDidUpdate((summary) => {
    if (summary.key === "dao:sanitized-route") {
      isolatedListenerRoute = summary.route;
    }
  });
  status.recordRoute("dao:sanitized-route", {
    modelUid: "safe-model-uid",
    provider: "safe-provider",
    upstreamModel: "safe-upstream",
    apiKey: "super-secret-api-key",
    headers: { authorization: "super-secret-header" },
    endpoint: "https://secret.invalid/v1",
  });
  mutatingRouteSubscription.dispose();
  observingRouteSubscription.dispose();
  const sanitizedRoute = status.summary("dao:sanitized-route").route;
  assert.deepStrictEqual(sanitizedRoute, {
    modelUid: "safe-model-uid",
    provider: "safe-provider",
    upstreamModel: "safe-upstream",
    provisional: false,
  });
  assert.deepStrictEqual(isolatedListenerRoute, sanitizedRoute);
  assert.doesNotMatch(
    JSON.stringify({ sanitizedRoute, isolatedListenerRoute }),
    /apiKey|headers|endpoint|super-secret/,
  );

  const legacyDir = path.join(tempHome, ".codeium", "dao-byok", "agent-status");
  const storeDir = path.join(stateDir(tempHome), "agent-status");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, "dao:legacy.json"),
    JSON.stringify({
      key: "dao:legacy",
      version: 7,
      updatedAt: now,
      execution: {
        totalToolCalls: 4,
        byTool: { read_file: 4 },
        consecutiveFailures: { read_file: 2 },
      },
    }),
  );
  const legacy = status._load("dao:legacy");
  assert.strictEqual(legacy.version, 7);
  assert.strictEqual(legacy.execution.totalToolCalls, 4);
  assert.deepStrictEqual(legacy.identity, { kind: "derived", id: "dao:legacy" });
  assert.strictEqual(legacy.mode, "");
  assert.strictEqual(legacy.activation.state, "dormant");
  assert.strictEqual(legacy.activity.requestInFlight, false);
  assert.deepStrictEqual(legacy.environment, {
    cwd: "",
    os: process.platform,
    gitBranch: "",
  });
  assert.deepStrictEqual(legacy.todos, []);
  assert.deepStrictEqual(legacy.strategy, []);
  assert.deepStrictEqual(legacy.route, {
    modelUid: "",
    provider: "",
    upstreamModel: "",
    provisional: true,
  });
  // 旧状态里的 verification 段被迁移整段丢弃（A 阶段），不再 fillMissing 出空壳
  assert.strictEqual(legacy.verification, undefined);
  assert.strictEqual(legacy.conclusions.canClaimComplete, false);
  assert.deepStrictEqual(legacy.execution.sameCall, {
    fingerprint: "",
    tool: "",
    count: 0,
    lastArgsPreview: "",
  });
  assert.deepStrictEqual(legacy._seenToolResultIds, {});
  const preparedLegacy = status.prepareOutbound({
    key: "dao:legacy",
    messages: [{ role: "user", content: "continue migrated task" }],
    cfg: cfg("on"),
  });
  assert.strictEqual(preparedLegacy.state.version, 8);
  assert.strictEqual(preparedLegacy.state.execution.totalToolCalls, 4);
  assert.deepStrictEqual(preparedLegacy.state.execution.byTool, { read_file: 4 });
  assert.deepStrictEqual(preparedLegacy.state.execution.consecutiveFailures, {
    read_file: 2,
  });

  fs.writeFileSync(
    path.join(legacyDir, "dao:legacy-route.json"),
    JSON.stringify({
      key: "dao:legacy-route",
      updatedAt: now,
      route: {
        modelUid: "legacy-model",
        provider: "legacy-provider",
        upstreamModel: "legacy-upstream",
      },
    }),
  );
  assert.deepStrictEqual(status._load("dao:legacy-route").route, {
    modelUid: "legacy-model",
    provider: "legacy-provider",
    upstreamModel: "legacy-upstream",
    provisional: true,
  });

  status.setMode("dao:atomic", "on", cfg("auto"));
  const atomicPath = path.join(storeDir, "dao:atomic.json");
  const beforeFailedSave = JSON.parse(fs.readFileSync(atomicPath, "utf8"));
  const atomicUpdates = [];
  const atomicSubscription = status.onDidUpdate((value) => {
    if (value.key === "dao:atomic") atomicUpdates.push(value);
  });
  const originalRenameSync = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("simulated atomic rename failure");
  };
  let failedRenameMode;
  try {
    failedRenameMode = status.setMode("dao:atomic", "off", cfg("auto"));
  } finally {
    fs.renameSync = originalRenameSync;
    atomicSubscription.dispose();
  }
  const afterFailedSave = JSON.parse(fs.readFileSync(atomicPath, "utf8"));
  assert.strictEqual(beforeFailedSave.mode, "on");
  assert.strictEqual(afterFailedSave.mode, "on");
  assert.strictEqual(failedRenameMode, null);
  assert.strictEqual(status.summary("dao:atomic").mode, "on");
  assert.deepStrictEqual(atomicUpdates, []);
  assert.deepStrictEqual(
    fs
      .readdirSync(storeDir)
      .filter((name) => name.startsWith("dao:atomic.json.") && name.endsWith(".tmp")),
    [],
  );

  status.setMode("dao:atomic-write", "on", cfg("auto"));
  const atomicWritePath = path.join(storeDir, "dao:atomic-write.json");
  const beforeFailedWrite = JSON.parse(
    fs.readFileSync(atomicWritePath, "utf8"),
  );
  const atomicWriteUpdates = [];
  const atomicWriteSubscription = status.onDidUpdate((value) => {
    if (value.key === "dao:atomic-write") atomicWriteUpdates.push(value);
  });
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (...args) => {
    originalWriteFileSync(...args);
    throw new Error("simulated atomic write failure");
  };
  let failedWriteMode;
  try {
    failedWriteMode = status.setMode("dao:atomic-write", "off", cfg("auto"));
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    atomicWriteSubscription.dispose();
  }
  const afterFailedWrite = JSON.parse(
    fs.readFileSync(atomicWritePath, "utf8"),
  );
  assert.strictEqual(beforeFailedWrite.mode, "on");
  assert.strictEqual(afterFailedWrite.mode, "on");
  assert.strictEqual(failedWriteMode, null);
  assert.strictEqual(status.summary("dao:atomic-write").mode, "on");
  assert.deepStrictEqual(atomicWriteUpdates, []);
  assert.deepStrictEqual(
    fs
      .readdirSync(storeDir)
      .filter(
        (name) =>
          name.startsWith("dao:atomic-write.json.") && name.endsWith(".tmp"),
      ),
    [],
  );

  const updates = [];
  const subscription = status.onDidUpdate((summary) => updates.push(summary));
  status.recordRoute("dao:auto-tools", {
    modelUid: "swe-1-6-slow",
    provider: "glm",
    upstreamModel: "glm-5.2",
  });
  subscription.dispose();
  assert.strictEqual(updates.at(-1).route.provider, "glm");
  assert.strictEqual(
    status.listSummaries().some((entry) => entry.key === "dao:auto-tools"),
    true,
  );
  assert.doesNotMatch(JSON.stringify(updates.at(-1)), /tool_calls|content/);
  status._test.resetNow();
  console.log("agent status baseline: PASS");
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
}

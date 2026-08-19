"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const packageJson = require("../package.json");

process.env.DAO_PP_SELFTEST = "1";

function makeVscodeStub() {
  const handler = {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => "";
      if (property === Symbol.iterator) return function* () {};
      if (property === "then") return undefined;
      if (property === "workspaceFolders") return undefined;
      return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
  };
  const proxy = new Proxy(function () {}, handler);
  return proxy;
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return makeVscodeStub();
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const extension = require("../extension.js");
  assert.ok(extension && extension.__test, "extension source imports without activation");
  const test = extension.__test;
  const legacyName = packageJson.displayName.split("·")[0].trim() || "FOMO FLOW";

  function statusItem() {
    return {
      text: "unchanged",
      tooltip: "unchanged tooltip",
      showCount: 0,
      show() { this.showCount += 1; },
    };
  }

  test._resetAgentHudWiring();
  test._setLegacyState({
    mode: "passthrough",
    port: 8985,
    lastQuickSwitch: "swe-1-6-slow → ay · gpt-5.6-terra",
  });

  const activeItem = statusItem();
  test._setStatusBarItem(activeItem);
  test._setAgentHud({ refresh() { return true; } });
  test.refreshStatusBar();
  assert.strictEqual(activeItem.text, "unchanged", "active HUD owns the Dao item");
  assert.strictEqual(activeItem.tooltip, "unchanged tooltip");
  assert.strictEqual(activeItem.showCount, 0);

  const inactiveItem = statusItem();
  test._setStatusBarItem(inactiveItem);
  test._setAgentHud({
    refresh() {
      test._renderLegacyDaoStatus();
      return false;
    },
  });
  test.refreshStatusBar();
  assert.strictEqual(inactiveItem.text, `$(circuit-board) ${legacyName} · 官`);
  assert.strictEqual(
    inactiveItem.tooltip,
    `${legacyName} · 模式=passthrough · 端口=8985\n` +
      "当前路由: swe-1-6-slow → ay · gpt-5.6-terra\n" +
      "点击快速切换模型 (cc-switch 式) · 完整面板在列表末项",
  );
  assert.strictEqual(inactiveItem.showCount, 1, "legacy item is shown");

  const throwingItem = statusItem();
  test._setStatusBarItem(throwingItem);
  test._setAgentHud({ refresh() { throw new Error("refresh secret"); } });
  assert.doesNotThrow(() => test.refreshStatusBar());
  assert.strictEqual(throwingItem.text, `$(circuit-board) ${legacyName} · 官`);
  assert.strictEqual(throwingItem.showCount, 1);

  const bound = [];
  test._setAgentHud({ bindSource(source) { bound.push(source); } });
  const runtime = { id: "fake-runtime" };
  assert.strictEqual(test._bindAgentHudRuntime(runtime), true);
  assert.strictEqual(test._bindAgentHudRuntime(null), true);
  assert.deepStrictEqual(bound, [runtime, null]);

  test._setAgentHud({ bindSource() { throw new Error("bind secret"); } });
  assert.strictEqual(test._bindAgentHudRuntime(runtime), false);
  for (const thrown of ["string bind failure", null]) {
    test._setAgentHud({ bindSource() { throw thrown; } });
    let result;
    assert.doesNotThrow(() => { result = test._bindAgentHudRuntime(runtime); });
    assert.strictEqual(result, false);
  }

  const lifecycleItem = statusItem();
  const lifecycleSources = [];
  let lifecycleRefreshes = 0;
  let stopCount = 0;
  const runningRuntime = {
    isRunning() { return true; },
    async stop() { stopCount += 1; },
  };
  test._setStatusBarItem(lifecycleItem);
  test._setAgentHud({
    bindSource(source) {
      lifecycleSources.push(source);
      test._renderLegacyDaoStatus();
    },
    refresh() {
      lifecycleRefreshes += 1;
      test._renderLegacyDaoStatus();
      return false;
    },
  });
  test._setExternalApiRuntime(runningRuntime);
  const startResult = test.tryStartExternalApi(null);
  assert.ok(startResult && typeof startResult.then === "function");
  assert.deepStrictEqual(lifecycleSources, [runningRuntime]);
  assert.strictEqual(lifecycleRefreshes, 0, "bindSource owns its refresh lifecycle");
  assert.strictEqual(lifecycleItem.showCount, 1, "runtime bind renders legacy exactly once");
  const stopResult = test.tryStopExternalApi();
  assert.ok(stopResult && typeof stopResult.then === "function");
  assert.deepStrictEqual(lifecycleSources, [runningRuntime, null]);
  assert.strictEqual(lifecycleRefreshes, 0);
  assert.strictEqual(lifecycleItem.showCount, 2, "runtime unbind renders legacy exactly once");
  assert.strictEqual(stopCount, 1);

  const command = packageJson.contributes.commands.find(
    (entry) => entry.command === "fomo.agentHud",
  );
  assert.deepStrictEqual(command, {
    command: "fomo.agentHud",
    title: "FOMO FLOW: Agent HUD",
    category: "FOMO FLOW",
  });

  test._resetAgentHudWiring();
  console.log("agent HUD extension wiring: PASS");
} finally {
  Module._load = originalLoad;
  delete process.env.DAO_PP_SELFTEST;
}

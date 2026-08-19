"use strict";

const assert = require("node:assert");
const { createAgentHudVscode, sessionItem } = require("../core/agent_hud_vscode.js");
const packageJson = require("../package.json");

(async function main() {
  assert.ok(
    packageJson.contributes.commands.some((command) => command.command === "fomo.agentHud"),
    "package contributes the Agent HUD command",
  );

  let now = 1_000_000;
  const statusItems = [];
  const quickPickAnswers = [];
  const quickPickCalls = [];
  const infoMessages = [];
  const warningMessages = [];

  class ThemeColor {
    constructor(id) { this.id = id; }
  }

  const vscode = {
    StatusBarAlignment: { Right: 2 },
    ThemeColor,
    window: {
      createStatusBarItem(alignment, priority) {
        const item = {
          alignment,
          priority,
          visible: true,
          disposedCount: 0,
          show() { this.visible = true; },
          hide() { this.visible = false; },
          dispose() { this.disposedCount += 1; },
        };
        statusItems.push(item);
        return item;
      },
      async showQuickPick(items, options) {
        quickPickCalls.push({ items, options });
        const answer = quickPickAnswers.shift();
        if (!answer) return undefined;
        if (answer.type === "session") {
          return items.find((item) => item._key === answer.key);
        }
        if (answer.type === "action") {
          return items.find((item) => item._action === answer.action);
        }
        throw new Error("Unexpected QuickPick answer");
      },
      async showInformationMessage(message) { infoMessages.push(message); },
      async showWarningMessage(message) { warningMessages.push(message); },
    },
  };

  const daoItem = {
    text: "legacy Dao",
    tooltip: "legacy tooltip",
    visible: true,
    showCount: 0,
    disposedCount: 0,
    show() { this.visible = true; this.showCount += 1; },
    dispose() { this.disposedCount += 1; },
  };
  let pinnedKey = null;
  const pinWrites = [];
  const context = {
    workspaceState: {
      get(key, fallback) {
        assert.strictEqual(key, "dao.agentHud.pinnedKey");
        return pinnedKey == null ? fallback : pinnedKey;
      },
      update(key, value) {
        assert.strictEqual(key, "dao.agentHud.pinnedKey");
        pinnedKey = value;
        pinWrites.push(value);
        return Promise.resolve();
      },
    },
  };

  function summary(key, overrides = {}) {
    const value = {
      key,
      version: 1,
      updatedAt: now,
      identity: { kind: "native", id: `producer-${key}-secret` },
      mode: "auto",
      activation: { state: "active", reason: "tools", activatedAt: now - 100 },
      activity: { requestInFlight: false, lastUpdateAt: now },
      goal: `Goal ${key}`,
      phase: "exploring",
      todo: { completed: 2, total: 5, current: "inspect" },
      verification: { latestTestStatus: "unknown", blocking: false },
      failures: { maxConsecutive: 0, sameCallStreak: 0, lastToolOk: true, hasLastError: false },
      route: { modelUid: "swe-1-6-slow", provider: "ay", upstreamModel: "gpt-5.6-terra" },
      workspace: "/Users/alice/private/repo-a",
      error: "producer raw error body",
      headers: { authorization: "Bearer producer-token" },
    };
    for (const [name, override] of Object.entries(overrides)) {
      value[name] = override && typeof override === "object" && !Array.isArray(override)
        ? { ...value[name], ...override }
        : override;
    }
    return value;
  }

  function makeSource(name, initial = []) {
    const listeners = new Set();
    return {
      name,
      values: initial.slice(),
      modeChanges: [],
      options: { enabled: true, defaultMode: "auto", hud: { enabled: true, activeTtlMs: 2_000, staleTtlMs: 8_000 } },
      listThrows: false,
      subscribeThrows: false,
      optionsThrows: false,
      setModeThrows: false,
      subscriptionDisposeCount: 0,
      agentStatusList() {
        if (this.listThrows) throw new Error(`${name} list secret`);
        return this.values.slice();
      },
      agentStatusSubscribe(listener) {
        if (this.subscribeThrows) throw new Error(`${name} subscribe secret`);
        listeners.add(listener);
        let disposed = false;
        return {
          dispose: () => {
            if (disposed) return;
            disposed = true;
            listeners.delete(listener);
            this.subscriptionDisposeCount += 1;
          },
        };
      },
      agentStatusOptions() {
        if (this.optionsThrows) throw new Error(`${name} options secret`);
        return this.options;
      },
      agentStatusSetMode(key, mode) {
        if (this.setModeThrows) throw new Error(`${name} mode producer secret`);
        this.modeChanges.push({ key, mode });
        const previous = this.values.find((value) => value.key === key);
        if (!previous) return null;
        const updatedAt = ++now;
        const next = {
          ...previous,
          version: previous.version + 1,
          updatedAt,
          mode,
          activation: { ...previous.activation, state: mode === "off" ? "off" : "active" },
          activity: { ...previous.activity, lastUpdateAt: updatedAt },
        };
        this.values = this.values.map((value) => value.key === key ? next : value);
        return next;
      },
      emit(value) {
        this.values = this.values.filter((entry) => entry.key !== value.key).concat(value);
        for (const listener of listeners) listener(value);
      },
      listenerCount() { return listeners.size; },
    };
  }

  const derivedItem = sessionItem(summary("derived", {
    goal: `  A\n derived goal ${"x".repeat(100)}`,
    workspace: "C:\\private\\derived-repo",
    mode: "on",
    phase: "testing",
    todo: { completed: 1, total: 3 },
    verification: { latestTestStatus: "failed" },
    identity: { kind: "derived", id: "derived-identity-secret" },
  }), now);
  assert.strictEqual(Object.keys(derivedItem).sort().join(","), "_key,description,detail,label");
  assert.ok(derivedItem.label.length <= 72);
  assert.doesNotMatch(derivedItem.label, /\n/);
  assert.strictEqual(derivedItem.description, "derived-repo · on/tools · derived");
  assert.strictEqual(derivedItem.detail, "testing · 1/3 · failed · updated 0s ago");
  assert.doesNotMatch(JSON.stringify(derivedItem), /private|derived-identity-secret|producer-token|raw error/);
  assert.deepStrictEqual(sessionItem({ key: "empty" }), {
    label: "Untitled session",
    description: "workspace · auto",
    detail: "start · 0/0 · test? · updated unknown",
    _key: "empty",
  });

  const source1 = makeSource("source1");
  const intervalCalls = [];
  const clearedTimers = [];
  const fakeTimer = { unrefCount: 0, unref() { this.unrefCount += 1; } };
  const hud = createAgentHudVscode(vscode, context, {
    daoItem,
    source: source1,
    globalMode: () => "invert",
    now: () => now,
    activeTtlMs: 2_000,
    staleTtlMs: 8_000,
    setIntervalFn(callback, ms) { intervalCalls.push({ callback, ms }); return fakeTimer; },
    clearIntervalFn(timer) { clearedTimers.push(timer); },
  });
  const agentItem = statusItems[0];

  assert.strictEqual(statusItems.length, 1, "adapter creates only the Agent item; Dao is injected");
  assert.strictEqual(agentItem.alignment, vscode.StatusBarAlignment.Right);
  assert.strictEqual(agentItem.priority, 99);
  assert.strictEqual(agentItem.command, "fomo.agentHud");
  assert.strictEqual(agentItem.visible, false);
  assert.strictEqual(daoItem.text, "legacy Dao", "idle leaves the legacy Dao item alone");
  assert.strictEqual(intervalCalls.length, 1);
  assert.strictEqual(intervalCalls[0].ms, 2_000);
  assert.strictEqual(fakeTimer.unrefCount, 1);

  const longGoal = `Goal A ${"g".repeat(150)}`;
  source1.emit(summary("A", { goal: longGoal }));
  assert.strictEqual(agentItem.visible, true);
  assert.match(daoItem.text, /slow→ay/);
  assert.match(agentItem.text, /exploring/);
  assert.strictEqual(agentItem.backgroundColor, undefined);

  now += 1;
  source1.emit(summary("A", {
    version: 2,
    updatedAt: now,
    goal: longGoal,
    activity: { lastUpdateAt: now },
    verification: { latestTestStatus: "failed" },
  }));
  assert.ok(agentItem.backgroundColor instanceof ThemeColor);
  assert.strictEqual(agentItem.backgroundColor.id, "statusBarItem.warningBackground");

  now += 1;
  source1.emit(summary("A", {
    version: 3,
    updatedAt: now,
    goal: longGoal,
    activity: { lastUpdateAt: now },
    verification: { latestTestStatus: "passed" },
  }));
  assert.strictEqual(agentItem.backgroundColor, undefined, "later healthy state clears warning color");

  now += 1;
  source1.emit(summary("B", {
    updatedAt: now,
    activity: { lastUpdateAt: now },
    phase: "testing",
    workspace: "/home/producer/super-secret/repo-b",
    route: { provider: "private-provider" },
  }));
  assert.match(daoItem.text, /Dao · multi/);
  assert.match(agentItem.text, /2 active/);
  assert.doesNotMatch(`${daoItem.text} ${daoItem.tooltip} ${agentItem.text} ${agentItem.tooltip}`, /exploring|testing|private-provider|repo-[ab]/);

  quickPickAnswers.push({ type: "session", key: "A" }, { type: "action", action: "off" });
  await hud.open();
  assert.deepStrictEqual(source1.modeChanges.at(-1), { key: "A", mode: "off" });
  assert.strictEqual(hud.controller.project().kind, "single");
  assert.strictEqual(hud.controller.project().key, "B");
  assert.match(agentItem.text, /testing/);
  assert.strictEqual(quickPickCalls.at(-2).options.matchOnDescription, true);
  assert.strictEqual(quickPickCalls.at(-2).options.matchOnDetail, true);
  assert.strictEqual(quickPickCalls.at(-2).items[0]._key, "B", "newest session is listed first");
  assert.match(quickPickCalls.at(-2).items[0].description, /auto\/tools/);
  assert.match(quickPickCalls.at(-2).items[0].detail, /updated \d+s ago/);
  assert.deepStrictEqual(quickPickCalls.at(-1).items.map((item) => item._action), ["pin", "auto", "on", "off", "details"]);
  assert.doesNotMatch(JSON.stringify(quickPickCalls.at(-2).items), /\/Users\/alice|producer-A-secret|producer-token|raw error|authorization/);

  quickPickAnswers.push({ type: "session", key: "B" }, { type: "action", action: "pin" });
  await hud.open();
  assert.strictEqual(hud.controller.project().kind, "pinned");
  assert.strictEqual(hud.controller.project().key, "B");
  assert.strictEqual(pinWrites.at(-1), "B");

  quickPickAnswers.push({ type: "session", key: "B" }, { type: "action", action: "unpin" });
  await hud.open();
  assert.ok(quickPickCalls.at(-1).items.some((item) => item.label === "Unpin"));
  assert.strictEqual(hud.controller.project().kind, "single");
  assert.strictEqual(pinWrites.at(-1), null);

  quickPickAnswers.push({ type: "session", key: "A" }, { type: "action", action: "details" });
  await hud.open();
  const detailMessage = infoMessages.at(-1);
  assert.match(detailMessage, /Goal A/);
  assert.match(detailMessage, /repo-a/);
  assert.match(detailMessage, /phase=exploring/);
  assert.match(detailMessage, /todo=2\/5/);
  assert.match(detailMessage, /verification=passed/);
  assert.match(detailMessage, /mode=off/);
  assert.match(detailMessage, /identity=native/);
  assert.ok(detailMessage.includes(longGoal.slice(0, 120)));
  assert.ok(!detailMessage.includes(longGoal.slice(0, 121)));
  assert.doesNotMatch(detailMessage, /\/Users\/alice|producer-A-secret|producer-token|raw error|authorization/);

  const daoBeforeDisabled = { text: daoItem.text, tooltip: daoItem.tooltip };
  source1.options = { enabled: false, defaultMode: "auto", hud: { enabled: true } };
  assert.strictEqual(hud.refresh(), false);
  assert.strictEqual(agentItem.visible, false);
  assert.deepStrictEqual({ text: daoItem.text, tooltip: daoItem.tooltip }, daoBeforeDisabled);
  source1.options = { enabled: true, defaultMode: "auto", hud: { enabled: false } };
  assert.strictEqual(hud.refresh(), false);
  assert.strictEqual(agentItem.visible, false);
  source1.options = { enabled: true, defaultMode: "auto", hud: { enabled: true, activeTtlMs: 2_000, staleTtlMs: 8_000 } };
  assert.strictEqual(hud.refresh(), true);
  assert.strictEqual(agentItem.visible, true);
  source1.options.hud.activeTtlMs = 1_000;
  now += 1_001;
  assert.strictEqual(hud.refresh(), false, "refresh applies source TTL options each time");
  source1.options.hud.activeTtlMs = 2_000;
  assert.strictEqual(hud.refresh(), true);

  source1.setModeThrows = true;
  const modeBeforeFailure = hud.controller.list().find((value) => value.key === "B").mode;
  quickPickAnswers.push({ type: "session", key: "B" }, { type: "action", action: "off" });
  await assert.doesNotReject(() => hud.open());
  assert.strictEqual(warningMessages.at(-1), "Unable to change this Agent HUD session mode.");
  assert.strictEqual(hud.controller.list().find((value) => value.key === "B").mode, modeBeforeFailure);
  assert.doesNotMatch(warningMessages.at(-1), /producer secret/);
  source1.setModeThrows = false;

  const badList = makeSource("bad-list");
  badList.listThrows = true;
  assert.doesNotThrow(() => hud.bindSource(badList));
  assert.strictEqual(agentItem.visible, false);
  const badSubscribe = makeSource("bad-subscribe");
  badSubscribe.subscribeThrows = true;
  assert.doesNotThrow(() => hud.bindSource(badSubscribe));
  assert.strictEqual(agentItem.visible, false);
  const badOptions = makeSource("bad-options", [summary("bad-options-session")]);
  badOptions.optionsThrows = true;
  assert.doesNotThrow(() => hud.bindSource(badOptions));
  assert.strictEqual(hud.refresh(), false);
  assert.strictEqual(agentItem.visible, false);

  hud.bindSource(null);
  await assert.doesNotReject(() => hud.open());
  assert.strictEqual(infoMessages.at(-1), "Agent HUD is unavailable until Dao routing starts.");
  const emptySource = makeSource("empty");
  hud.bindSource(emptySource);
  await hud.open();
  assert.strictEqual(infoMessages.at(-1), "No Agent HUD sessions yet.");

  const source2 = makeSource("source2", [summary("C", {
    updatedAt: ++now,
    activity: { lastUpdateAt: now },
    phase: "planning",
    workspace: "repo-c",
  })]);
  hud.bindSource(source1);
  const source1DisposalsBeforeRebind = source1.subscriptionDisposeCount;
  hud.bindSource(source2);
  assert.strictEqual(source1.subscriptionDisposeCount, source1DisposalsBeforeRebind + 1);
  assert.strictEqual(source1.listenerCount(), 0);
  assert.deepStrictEqual(hud.controller.list().map((value) => value.key), ["C"]);
  assert.strictEqual(hud.controller.project().kind, "single", "old source sessions cannot create false multi state");
  assert.match(agentItem.text, /planning/);

  const source2DisposalsBeforeSameBind = source2.subscriptionDisposeCount;
  hud.bindSource(source2);
  assert.strictEqual(source2.subscriptionDisposeCount, source2DisposalsBeforeSameBind + 1);
  assert.strictEqual(source2.listenerCount(), 1, "same-source rebind leaves one listener");

  const source2DisposalsBeforeDispose = source2.subscriptionDisposeCount;
  hud.dispose();
  hud.dispose();
  assert.strictEqual(clearedTimers.length, 1);
  assert.strictEqual(clearedTimers[0], fakeTimer);
  assert.strictEqual(source2.subscriptionDisposeCount, source2DisposalsBeforeDispose + 1);
  assert.strictEqual(agentItem.disposedCount, 1);
  assert.strictEqual(daoItem.disposedCount, 0);

  {
    let resolveActionPick;
    const actionPick = new Promise((resolve) => { resolveActionPick = resolve; });
    const pickCalls = [];
    const lifecyclePinWrites = [];
    const lifecycleItems = [];
    const lifecycleVscode = {
      StatusBarAlignment: { Right: 2 },
      ThemeColor,
      window: {
        createStatusBarItem() {
          const item = {
            show() {},
            hide() {},
            dispose() {},
          };
          lifecycleItems.push(item);
          return item;
        },
        showQuickPick(items) {
          pickCalls.push(items);
          return pickCalls.length === 1
            ? Promise.resolve(items.find((item) => item._key === "picker-A"))
            : actionPick;
        },
        async showInformationMessage() {},
        async showWarningMessage() {},
      },
    };
    const lifecycleContext = {
      workspaceState: {
        get() { return null; },
        update(_key, value) { lifecyclePinWrites.push(value); },
      },
    };
    const lifecycleSource = makeSource("dispose-picker", [summary("picker-A")]);
    const lifecycleHud = createAgentHudVscode(lifecycleVscode, lifecycleContext, {
      daoItem: { show() {} },
      source: lifecycleSource,
      now: () => now,
      setIntervalFn() { return 21; },
      clearIntervalFn() {},
    });
    const opening = lifecycleHud.open();
    await Promise.resolve();
    assert.strictEqual(pickCalls.length, 2);
    lifecycleHud.dispose();
    resolveActionPick({ _action: "pin" });
    await opening;
    assert.strictEqual(pickCalls.length, 2, "disposing invalidates a pending action picker");
    assert.deepStrictEqual(lifecyclePinWrites, []);
    assert.deepStrictEqual(lifecycleSource.modeChanges, []);
    assert.strictEqual(lifecycleItems.length, 1);
  }

  {
    let resolveActionPick;
    const actionPick = new Promise((resolve) => { resolveActionPick = resolve; });
    const pickCalls = [];
    const rebindPinWrites = [];
    const rebindVscode = {
      StatusBarAlignment: { Right: 2 },
      ThemeColor,
      window: {
        createStatusBarItem() {
          return { show() {}, hide() {}, dispose() {} };
        },
        showQuickPick(items) {
          pickCalls.push(items);
          return pickCalls.length === 1
            ? Promise.resolve(items.find((item) => item._key === "picker-B"))
            : actionPick;
        },
        async showInformationMessage() {},
        async showWarningMessage() {},
      },
    };
    const rebindSource = makeSource("rebind-picker", [summary("picker-B")]);
    const rebindHud = createAgentHudVscode(rebindVscode, {
      workspaceState: {
        get() { return null; },
        update(_key, value) { rebindPinWrites.push(value); },
      },
    }, {
      daoItem: { show() {} },
      source: rebindSource,
      now: () => now,
      setIntervalFn() { return 22; },
      clearIntervalFn() {},
    });
    const opening = rebindHud.open();
    await Promise.resolve();
    assert.strictEqual(pickCalls.length, 2);
    rebindHud.bindSource(rebindSource);
    resolveActionPick({ _action: "off" });
    await opening;
    assert.strictEqual(pickCalls.length, 2, "same-source rebind invalidates an old action picker");
    assert.deepStrictEqual(rebindPinWrites, []);
    assert.deepStrictEqual(rebindSource.modeChanges, []);
    rebindHud.dispose();
  }

  {
    let restoredPin = "restore-A";
    let pinReads = 0;
    const restoredPinWrites = [];
    const restoredSource = makeSource("restored-pin");
    const restoredHud = createAgentHudVscode({
      StatusBarAlignment: { Right: 2 },
      ThemeColor,
      window: {
        createStatusBarItem() {
          return { show() {}, hide() {}, dispose() {} };
        },
      },
    }, {
      workspaceState: {
        get() { pinReads += 1; return restoredPin; },
        update(_key, value) {
          restoredPin = value;
          restoredPinWrites.push(value);
        },
      },
    }, {
      daoItem: { show() {} },
      source: restoredSource,
      now: () => now,
      setIntervalFn() { return 23; },
      clearIntervalFn() {},
    });
    assert.strictEqual(pinReads, 1, "workspace pin is read once by the adapter");
    assert.deepStrictEqual(restoredPinWrites, [], "empty initial list does not clear a pending pin");
    assert.strictEqual(restoredPin, "restore-A");
    restoredHud.bindSource(restoredSource);
    assert.strictEqual(pinReads, 1, "source rebind does not reread workspace state");
    assert.deepStrictEqual(restoredPinWrites, []);
    restoredSource.emit(summary("restore-A", { updatedAt: ++now, activity: { lastUpdateAt: now } }));
    assert.strictEqual(restoredHud.controller.project().kind, "pinned");
    assert.strictEqual(restoredHud.controller.project().key, "restore-A");
    assert.doesNotMatch(JSON.stringify(restoredPinWrites), /null/);
    restoredHud.dispose();
  }

  {
    let legacyNow = 5_000_000;
    let legacyRenderCount = 0;
    let throwAfterLegacyRender = false;
    const legacyTimers = [];
    const legacyItems = [];
    const legacyDao = { text: "legacy Dao", tooltip: "legacy tooltip", show() {} };
    const legacySource = makeSource("legacy-fallback", [summary("legacy-A", {
      updatedAt: legacyNow,
      activity: { lastUpdateAt: legacyNow },
      verification: { latestTestStatus: "failed" },
    })]);
    legacySource.options.hud.activeTtlMs = 1_000;
    const legacyHud = createAgentHudVscode({
      StatusBarAlignment: { Right: 2 },
      ThemeColor,
      window: {
        createStatusBarItem() {
          const item = {
            visible: true,
            show() { this.visible = true; },
            hide() { this.visible = false; },
            dispose() {},
          };
          legacyItems.push(item);
          return item;
        },
      },
    }, { workspaceState: { get() { return null; }, update() {} } }, {
      daoItem: legacyDao,
      source: legacySource,
      now: () => legacyNow,
      renderLegacyDao() {
        legacyRenderCount += 1;
        legacyDao.text = "legacy Dao restored";
        legacyDao.tooltip = "legacy tooltip restored";
        if (throwAfterLegacyRender) throw new Error("legacy renderer secret");
      },
      setIntervalFn(callback) { legacyTimers.push(callback); return 24; },
      clearIntervalFn() {},
    });
    assert.match(legacyDao.text, /slow→ay/);
    assert.strictEqual(legacyItems[0].backgroundColor.id, "statusBarItem.warningBackground");
    legacyNow += 1_001;
    assert.strictEqual(legacyTimers[0](), false);
    assert.strictEqual(legacyItems[0].visible, false);
    assert.strictEqual(legacyItems[0].backgroundColor, undefined);
    assert.strictEqual(legacyDao.text, "legacy Dao restored");
    assert.strictEqual(legacyRenderCount, 1);

    const reactivated = summary("legacy-A", {
      version: 2,
      updatedAt: legacyNow,
      activity: { lastUpdateAt: legacyNow },
    });
    legacySource.emit(reactivated);
    assert.strictEqual(legacyItems[0].visible, true);
    assert.match(legacyDao.text, /slow→ay/);
    legacySource.options.enabled = false;
    throwAfterLegacyRender = true;
    assert.doesNotThrow(() => legacyTimers[0]());
    assert.strictEqual(legacyItems[0].visible, false);
    assert.strictEqual(legacyDao.text, "legacy Dao restored");
    assert.strictEqual(legacyRenderCount, 2);
    legacyHud.dispose();
  }

  {
    let pendingModePin = "pending-mode-A";
    const pendingModeWrites = [];
    const pendingModeAnswers = [{ _key: "pending-mode-B" }, { _action: "on" }];
    const pendingModeSource = makeSource("pending-mode", [summary("pending-mode-B")]);
    const pendingModeHud = createAgentHudVscode({
      StatusBarAlignment: { Right: 2 },
      ThemeColor,
      window: {
        createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
        async showQuickPick() { return pendingModeAnswers.shift(); },
        async showInformationMessage() {},
        async showWarningMessage() {},
      },
    }, {
      workspaceState: {
        get() { return pendingModePin; },
        update(_key, value) { pendingModePin = value; pendingModeWrites.push(value); },
      },
    }, {
      daoItem: { show() {} },
      source: pendingModeSource,
      now: () => now,
      setIntervalFn() { return 26; },
      clearIntervalFn() {},
    });
    await pendingModeHud.open();
    assert.strictEqual(pendingModePin, "pending-mode-A", "mode changes do not alter an unrelated pending pin");
    assert.deepStrictEqual(pendingModeWrites, []);
    pendingModeSource.emit(summary("pending-mode-A", {
      updatedAt: ++now,
      activity: { lastUpdateAt: now },
    }));
    assert.strictEqual(pendingModeHud.controller.project().kind, "pinned");
    assert.strictEqual(pendingModeHud.controller.project().key, "pending-mode-A");
    assert.deepStrictEqual(pendingModeWrites, ["pending-mode-A"]);
    pendingModeHud.dispose();
  }

  {
    const nullModeWarnings = [];
    const nullModeAnswers = [{ _key: "null-mode-A" }, { _action: "off" }];
    const nullModeSource = makeSource("null-mode", [summary("null-mode-A")]);
    nullModeSource.agentStatusSetMode = function agentStatusSetMode(key, mode) {
      this.modeChanges.push({ key, mode });
      return null;
    };
    const nullModeHud = createAgentHudVscode({
      StatusBarAlignment: { Right: 2 },
      ThemeColor,
      window: {
        createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
        async showQuickPick() { return nullModeAnswers.shift(); },
        async showInformationMessage() {},
        async showWarningMessage(message) { nullModeWarnings.push(message); },
      },
    }, { workspaceState: { get() { return null; }, update() {} } }, {
      daoItem: { show() {} },
      source: nullModeSource,
      now: () => now,
      setIntervalFn() { return 25; },
      clearIntervalFn() {},
    });
    const modeBeforeNull = nullModeHud.controller.list()[0].mode;
    await nullModeHud.open();
    assert.deepStrictEqual(nullModeSource.modeChanges, [{ key: "null-mode-A", mode: "off" }]);
    assert.strictEqual(nullModeHud.controller.list()[0].mode, modeBeforeNull);
    assert.strictEqual(nullModeWarnings.at(-1), "Unable to change this Agent HUD session mode.");
    nullModeHud.dispose();
  }

  {
    const unhealthyItems = [];
    const unhealthyTimers = [];
    const unhealthyDao = {
      text: "$(circuit-board) Dao · stale→route",
      tooltip: "stale route",
      show() {},
    };
    let legacyRenders = 0;
    const unhealthyInfo = [];
    const unhealthyVscode = {
      StatusBarAlignment: { Right: 2 },
      ThemeColor,
      window: {
        createStatusBarItem() {
          const item = {
            visible: true,
            show() { this.visible = true; },
            hide() { this.visible = false; },
            dispose() {},
          };
          unhealthyItems.push(item);
          return item;
        },
        async showInformationMessage(message) { unhealthyInfo.push(message); },
      },
    };
    const unhealthySource = makeSource("unhealthy", [summary("unhealthy-session")]);
    unhealthySource.subscribeThrows = true;
    const unhealthyHud = createAgentHudVscode(unhealthyVscode, context, {
      daoItem: unhealthyDao,
      source: unhealthySource,
      now: () => now,
      renderLegacyDao() {
        legacyRenders += 1;
        unhealthyDao.text = "legacy Dao restored";
        unhealthyDao.tooltip = "legacy tooltip restored";
      },
      setIntervalFn(callback) { unhealthyTimers.push(callback); return 11; },
      clearIntervalFn() {},
    });
    assert.strictEqual(unhealthyItems[0].visible, false);
    assert.strictEqual(unhealthyTimers[0](), false, "timer cannot revive cached list after subscribe failure");
    assert.strictEqual(unhealthyItems[0].visible, false);
    assert.strictEqual(unhealthyDao.text, "legacy Dao restored");
    assert.strictEqual(legacyRenders, 2, "bind failure and timer refresh both restore legacy Dao");
    await unhealthyHud.open();
    assert.strictEqual(unhealthyInfo.at(-1), "Agent HUD updates are unavailable.");
    assert.doesNotMatch(unhealthyInfo.at(-1), /routing starts/i);
    unhealthyHud.dispose();
  }

  console.log("agent HUD VS Code adapter: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

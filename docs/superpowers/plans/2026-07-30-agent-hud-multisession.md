# Agent HUD Multi-Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a human-visible, per-conversation Dao + Agent status-bar HUD with Auto/On/Off control, safe multi-session aggregation, and no changes to Devin's editor layout.

**Architecture:** Recover the already-running model-facing `agent_status.js` into the repository, then extend it with a per-session activation state machine and sanitized update events. A pure `agent_hud.js` controller owns the window projection rules; a small VS Code adapter owns status-bar and QuickPick behavior, while `extension.js` and `dao_router.js` remain orchestration layers.

**Tech Stack:** Node.js CommonJS, VS Code extension API, synchronous JSON state persistence with atomic rename, repository self-tests using `node:assert`.

---

## Scope and repository safety

This is one cohesive feature: model-facing state, the human HUD, and route/session identity must ship together to avoid displaying stale or cross-session facts.

The worktree already contains unrelated user changes in `extension.js`, `package.json`, and `vendor/外接api/core/dao_router.js`. Preserve them. For these three files, inspect each diff before editing and stage only Agent HUD hunks with interactive patch staging. Never copy the installed versions over the repository versions wholesale.

The installed extension also contains P0 work that is not yet present in the repository:

- `~/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/agent_status.js`
- three narrow agent-status integration hunks in the installed `dao_router.js`

Recover only those known hunks. The installed `extension.js` differs from the repository by more than 200 lines, so live installation must apply equivalent narrow patches rather than replace the whole file.

## File map

- Create `vendor/外接api/core/agent_status.js`: canonical per-conversation state, observation, activation, model injection, summaries, events, and atomic persistence.
- Create `core/agent_hud.js`: pure window registry, active/stale pruning, pinning, warning calculation, and Dao/Agent projection.
- Create `core/agent_hud_vscode.js`: VS Code status-bar and QuickPick adapter; no routing logic.
- Modify `vendor/外接api/core/dao_router.js`: obtain the conversation key once, prepare model status, and record the actual successful channel.
- Modify `vendor/外接api/runtime.js`: narrow facade for list/subscribe/setMode and route-state access.
- Modify `extension.js`: create/bind/dispose the HUD adapter and preserve the existing quick-switch command.
- Modify `package.json`: contribute `daopp.agentHud`; stage only that hunk.
- Modify `vendor/外接api/core/_默认配置.json`: documented Auto/HUD defaults.
- Create `test/agent-status.test.js`: baseline and activation-state tests.
- Create `test/agent-status-router.test.js`: router facade and actual-route recording tests.
- Create `test/agent-hud.test.js`: pure multi-session projection tests.
- Create `test/agent-hud-vscode.test.js`: status item, command, QuickPick, and disposal tests using a VS Code stub.
- Modify `docs/CODE_STRUCTURE.md`: record the two new module boundaries.
- Modify `~/.codeium/dao-byok/HANDOFF.md`: live handoff facts after acceptance; do not commit this external file.

### Task 1: Recover the model-facing status baseline into source control

**Files:**
- Create: `vendor/外接api/core/agent_status.js`
- Create: `test/agent-status.test.js`

- [ ] **Step 1: Write the failing baseline test**

Create `test/agent-status.test.js` with this initial complete test:

```js
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-agent-status-"));
process.env.HOME = tempHome;

const status = require("../vendor/外接api/core/agent_status.js");

function cfg(mode = "on") {
  return {
    daoRoutes: {
      agentStatus: { enabled: true, defaultMode: mode, profile: "auto", softRules: true },
    },
  };
}

try {
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
  console.log("agent status baseline: PASS");
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the test and verify the source file is missing**

Run:

```bash
node test/agent-status.test.js
```

Expected: FAIL with `Cannot find module '../vendor/外接api/core/agent_status.js'`.

- [ ] **Step 3: Recover the vetted runtime baseline exactly**

Use `apply_patch` to add `vendor/外接api/core/agent_status.js` with the complete contents of:

```text
/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/agent_status.js
```

Do not edit the installed file in this step. Verify byte identity:

```bash
cmp vendor/外接api/core/agent_status.js \
  ~/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/agent_status.js
```

Expected: exit code 0 and no output.

- [ ] **Step 4: Run the baseline test**

Run:

```bash
node test/agent-status.test.js
```

Expected: `agent status baseline: PASS`.

- [ ] **Step 5: Commit only the recovered source and baseline test**

```bash
git add vendor/外接api/core/agent_status.js test/agent-status.test.js
git diff --cached --check
git commit -m "feat: recover agent status core"
```

Expected: the commit contains only those two new files.

### Task 2: Add Auto/On/Off activation, safe summaries, and atomic state events

**Files:**
- Modify: `vendor/外接api/core/agent_status.js`
- Modify: `test/agent-status.test.js`

- [ ] **Step 1: Extend the test with deterministic messages and a fake clock**

Append these helpers and assertions before the final `console.log` in `test/agent-status.test.js`:

```js
function toolTurn(id, name, args, result, isError = false) {
  return [
    {
      role: "assistant",
      tool_calls: [{ id, function: { name, arguments: JSON.stringify(args || {}) } }],
    },
    {
      role: "tool",
      tool_call_id: id,
      content: result,
      tool_result_is_error: isError,
    },
  ];
}

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
    ...toolTurn(`tool-${index}`, "read_file", { path: `f${index}.js` }, "ok"),
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

status.setMode("dao:auto-edit", "off", cfg("auto"));
const disabled = status.prepareOutbound({
  key: "dao:auto-edit",
  identityKind: "native",
  messages: editActivated.messages,
  cfg: cfg("auto"),
});
assert.strictEqual(disabled.injected, false);
assert.strictEqual(
  disabled.messages.some((message) =>
    String(message.content || "").includes("<agent_status"),
  ),
  false,
);

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

const updates = [];
const subscription = status.onDidUpdate((summary) => updates.push(summary));
status.recordRoute("dao:auto-tools", {
  modelUid: "swe-1-6-slow",
  provider: "glm",
  upstreamModel: "glm-5.2",
});
subscription.dispose();
assert.strictEqual(updates.at(-1).route.provider, "glm");
assert.strictEqual(status.listSummaries().some((entry) => entry.key === "dao:auto-tools"), true);
status._test.resetNow();
```

- [ ] **Step 2: Run the test and verify the new API is absent**

Run:

```bash
node test/agent-status.test.js
```

Expected: FAIL at `status._test.setNow` or `status.setMode` because the baseline does not expose activation controls.

- [ ] **Step 3: Add mode normalization and activation helpers**

Replace the existing `_now()` implementation with the injectable clock below, then add the remaining helpers near the existing configuration helpers in `agent_status.js`:

```js
const DEFAULT_AUTO_TOOL_CALLS = 3;
const DEFAULT_AUTO_AFTER_MS = 90_000;
const _listeners = new Set();
let _nowImpl = () => Date.now();

function _now() {
  return _nowImpl();
}

function _normalizeMode(value, fallback = "auto") {
  const mode = String(value || "").toLowerCase();
  return mode === "auto" || mode === "on" || mode === "off" ? mode : fallback;
}

function _defaultMode(cfg) {
  const as = _cfgAgentStatus(cfg);
  return _normalizeMode(as.defaultMode, "auto");
}

function _autoReason(state, cfg) {
  const as = _cfgAgentStatus(cfg);
  const auto = (as && as.auto) || {};
  const byTool = (state.execution && state.execution.byTool) || {};
  const toolNames = Object.keys(byTool).join(" ").toLowerCase();
  if ((state.conclusions && state.conclusions.openTodos) > 0) return "todo";
  if (/edit|write|multi_edit|apply_patch/.test(toolNames)) return "edit";
  if (/pytest|jest|vitest|test/.test(toolNames)) return "test";
  if (/terminal|exec|run_command|bash|shell/.test(toolNames)) return "terminal";
  if (
    (state.conclusions && state.conclusions.maxConsecutiveFailure) > 0 ||
    (state.verification && state.verification.latestTestStatus) === "failed"
  ) return "failure";
  const minCalls = Math.max(1, Number(auto.minToolCalls) || DEFAULT_AUTO_TOOL_CALLS);
  if ((state.execution.totalToolCalls || 0) >= minCalls) return "tools";
  const afterMs = Math.max(1_000, Number(auto.activateAfterMs) || DEFAULT_AUTO_AFTER_MS);
  if (_now() - state.createdAt >= afterMs) return "duration";
  return "";
}

function _applyActivation(state, cfg) {
  state.mode = _normalizeMode(state.mode, _defaultMode(cfg));
  if (state.mode === "off") {
    state.activation = { state: "disabled", reason: "off", activatedAt: 0 };
    return state.activation;
  }
  if (state.mode === "on") {
    state.activation = {
      state: "active",
      reason: "manual",
      activatedAt: (state.activation && state.activation.activatedAt) || _now(),
    };
    return state.activation;
  }
  if (state.activation && state.activation.state === "active") return state.activation;
  const reason = _autoReason(state, cfg);
  state.activation = reason
    ? { state: "active", reason, activatedAt: _now() }
    : { state: "dormant", reason: "", activatedAt: 0 };
  return state.activation;
}
```

Update `_emptyState` with these exact initial fields. `mode` is intentionally empty so the first request can inherit `defaultMode` instead of always becoming Auto:

```js
identity: { kind: "derived", id: String(key || "") },
mode: "",
activation: { state: "dormant", reason: "", activatedAt: 0 },
activity: { requestInFlight: false, lastRequestAt: 0, lastUpdateAt: 0 },
```

In `_load`, migrate each missing object independently without changing existing versions or counters:

```js
if (!obj.identity) obj.identity = { kind: "derived", id: String(key || "") };
if (!Object.prototype.hasOwnProperty.call(obj, "mode")) obj.mode = "";
if (!obj.activation) obj.activation = { state: "dormant", reason: "", activatedAt: 0 };
if (!obj.activity) obj.activity = { requestInFlight: false, lastRequestAt: 0, lastUpdateAt: 0 };
```

- [ ] **Step 4: Add sanitized summary and event APIs**

Replace the old sparse `summary` body with a shared `_publicSummary` and expose the event API:

```js
function _publicSummary(state) {
  const execution = state.execution || {};
  const verification = state.verification || {};
  const conclusions = state.conclusions || {};
  return {
    key: state.key,
    version: state.version || 0,
    updatedAt: state.updatedAt || 0,
    identity: { ...(state.identity || { kind: "derived", id: state.key }) },
    mode: state.mode || "auto",
    activation: { ...(state.activation || { state: "dormant", reason: "", activatedAt: 0 }) },
    activity: { ...(state.activity || {}) },
    goal: String(state.goal || "").replace(/\s+/g, " ").slice(0, 120),
    phase: state.phase || "start",
    todo: {
      completed: state._todoCompleted || 0,
      total: state._todoTotal || 0,
      current: String(state._currentTodo || "none").slice(0, 100),
    },
    verification: {
      latestTestStatus: verification.latestTestStatus || "unknown",
      blocking: !!conclusions.verificationBlocking,
    },
    failures: {
      maxConsecutive: conclusions.maxConsecutiveFailure || 0,
      sameCallStreak: conclusions.sameCallFailureStreak || 0,
      lastToolOk: execution.lastToolOk,
      hasLastError: !!execution.lastError,
    },
    route: { ...(state.route || {}) },
    workspace: path.basename((state.environment && state.environment.cwd) || ""),
  };
}

function _emit(state) {
  const value = _publicSummary(state);
  for (const listener of [..._listeners]) {
    try { listener(value); } catch (_) {}
  }
}

function onDidUpdate(listener) {
  if (typeof listener !== "function") return { dispose() {} };
  _listeners.add(listener);
  return { dispose() { _listeners.delete(listener); } };
}

function listSummaries() {
  return [..._mem.values()].map(_publicSummary);
}

function setMode(key, mode, cfg) {
  const state = _load(key);
  state.mode = _normalizeMode(mode);
  if (state.mode === "auto") state.activation = { state: "dormant", reason: "", activatedAt: 0 };
  _applyActivation(state, cfg);
  _save(state);
  return _publicSummary(state);
}

function recordRoute(key, route) {
  if (!key) return null;
  const state = _load(key);
  state.route = { ...state.route, ...route, provisional: false };
  state.activity.requestInFlight = false;
  state.activity.lastUpdateAt = _now();
  _save(state);
  return _publicSummary(state);
}

function finishRequest(key) {
  if (!key) return null;
  const state = _load(key);
  state.activity.requestInFlight = false;
  state.activity.lastUpdateAt = _now();
  _save(state);
  return _publicSummary(state);
}

function options(cfg) {
  const as = _cfgAgentStatus(cfg);
  const auto = (as && as.auto) || {};
  const hud = (as && as.hud) || {};
  return {
    enabled: isEnabled(cfg),
    defaultMode: _defaultMode(cfg),
    auto: {
      minToolCalls: Math.max(1, Number(auto.minToolCalls) || DEFAULT_AUTO_TOOL_CALLS),
      activateAfterMs: Math.max(1_000, Number(auto.activateAfterMs) || DEFAULT_AUTO_AFTER_MS),
    },
    hud: {
      enabled: hud.enabled !== false,
      activeTtlMs: Math.max(1_000, Number(hud.activeTtlMs) || 120_000),
      staleTtlMs: Math.max(1_000, Number(hud.staleTtlMs) || 7_200_000),
    },
  };
}
```

Call `_emit(state)` after a successful save. Listener failures must be isolated.

- [ ] **Step 5: Make persistence atomic**

Replace the direct `writeFileSync(_filePath(...))` section with:

```js
const destination = _filePath(state.key);
const temporary = `${destination}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
try {
  fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, destination);
} catch (_) {
  try { fs.unlinkSync(temporary); } catch (_) {}
}
_emit(state);
```

The in-memory state remains usable if disk persistence fails.

- [ ] **Step 6: Apply activation inside `prepareOutbound`**

Use this order so disabled/dormant sessions also remove stale model snapshots:

```js
const cleaned = stripStatusMessages(messages);
if (!isEnabled(cfg)) return { messages: cleaned, state: null, injected: false };

const state = _load(key || "anon");
state.identity = {
  kind: identityKind === "native" ? "native" : "derived",
  id: String(identityId || key || "anon").replace(/^dao:/, ""),
};
state.mode = state.mode || _defaultMode(cfg);
state.activity.requestInFlight = true;
state.activity.lastRequestAt = _now();

state.route.modelUid = modelUid || state.route.modelUid || "";
if (!state.route.provider && provider) {
  state.route.provider = provider;
  state.route.upstreamModel = upstreamModel || "";
  state.route.provisional = true;
}

observeMessages(state, cleaned, observeOpts);
_applyActivation(state, cfg);
_save(state);

if (state.activation.state !== "active") {
  return { messages: cleaned, state, injected: false };
}
return { messages: injectIntoMessages(cleaned, state), state, injected: true };
```

Export `setMode`, `listSummaries`, `onDidUpdate`, `recordRoute`, `finishRequest`, `options`, and a `_test` clock seam:

```js
_test: {
  setNow(fn) { _nowImpl = fn; },
  resetNow() { _nowImpl = () => Date.now(); },
  publicSummary: _publicSummary,
  autoReason: _autoReason,
}
```

- [ ] **Step 7: Run the focused test**

```bash
node test/agent-status.test.js
```

Expected: `agent status baseline: PASS` with all assertions completing.

- [ ] **Step 8: Commit the activation core**

```bash
git add vendor/外接api/core/agent_status.js test/agent-status.test.js
git diff --cached --check
git commit -m "feat: add per-session agent status modes"
```

### Task 3: Integrate the status core with routing and record the actual channel

**Files:**
- Modify: `vendor/外接api/core/dao_router.js:487-505, 2936-3192, 3428-3456, 3520-3577, 8190-8273`
- Modify: `vendor/外接api/runtime.js:100-226, 600-end`
- Create: `test/agent-status-router.test.js`

- [ ] **Step 1: Write the failing router/facade test**

Create `test/agent-status-router.test.js`:

```js
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-agent-router-"));
process.env.HOME = tempHome;
process.env.DAO_BYOK_CONFIG = path.join(tempHome, "配置.json");
fs.writeFileSync(process.env.DAO_BYOK_CONFIG, JSON.stringify({
  providers: {},
  daoRoutes: { agentStatus: { enabled: true, defaultMode: "on" }, routes: {} },
}));

try {
  const router = require("../vendor/外接api/core/dao_router.js");
  const runtime = require("../vendor/外接api/runtime.js");
  assert.strictEqual(typeof router.agentStatusSubscribe, "function");
  assert.strictEqual(typeof router.agentStatusSetMode, "function");
  assert.strictEqual(typeof router._test.recordAgentRoute, "function");
  assert.strictEqual(typeof runtime.agentStatusList, "function");
  assert.strictEqual(runtime.agentStatusOptions().defaultMode, "on");

  router._test.prepareAgentStatus({
    key: "dao:route-a",
    identityKind: "native",
    messages: [{ role: "user", content: "验证降级" }],
    modelUid: "swe-1-6-slow",
    cfg: { daoRoutes: { agentStatus: { enabled: true, defaultMode: "on" } } },
  });
  router._test.recordAgentRoute(
    { _agentStatusKey: "dao:route-a" },
    "swe-1-6-slow",
    { provider: "glm", model: "glm-5.2" },
  );
  const summary = router.agentStatusSummary("dao:route-a");
  assert.strictEqual(summary.route.provider, "glm");
  assert.strictEqual(summary.route.upstreamModel, "glm-5.2");
  assert.strictEqual(summary.activity.requestInFlight, false);
  console.log("agent status router facade: PASS");
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the test and verify the router API is absent**

```bash
node test/agent-status-router.test.js
```

Expected: FAIL because `agentStatusSubscribe` and the `_test` helpers do not exist.

- [ ] **Step 3: Load agent status independently of optional legacy modules**

In `dao_router.js`, add a dedicated guarded require after the existing optional-module block so one missing observability module cannot disable Agent Status:

```js
let _agentStatus = null;
try {
  _agentStatus = require(path.join(__dirname, "agent_status"));
} catch (error) {
  _log(`[dao-router] agent_status load fail: ${error.message}`);
}
```

Do not place this require inside the large shared `try` at lines 487-502.

- [ ] **Step 4: Prepare the model snapshot after all message compaction**

Add a helper and call it immediately before `callOpts` is created:

```js
function _prepareAgentStatus(options) {
  if (!_agentStatus) return { messages: options.messages, state: null, injected: false };
  return _agentStatus.prepareOutbound(options);
}

const identityKind = parsed.cascadeId ? "native" : "derived";
const preparedStatus = _prepareAgentStatus({
  key: _conversationKey,
  identityKind,
  identityId: parsed.cascadeId || _conversationKey,
  messages,
  modelUid: modelUid || parsed.modelUid || "",
  provider: target.provider || "",
  upstreamModel: target.model || "",
  workspaceRoots: _requestWorkspaceRootsValue || [],
  cfg: _cfg,
});
messages = preparedStatus.messages;
```

Set `_agentStatusKey: _conversationKey` on `callOpts`.

- [ ] **Step 5: Record the actual successful provider, including fallback**

Add and use this helper:

```js
function _recordAgentRoute(callOpts, modelUid, selectedTarget) {
  if (!_agentStatus || !callOpts || !callOpts._agentStatusKey || !selectedTarget) return null;
  return _agentStatus.recordRoute(callOpts._agentStatusKey, {
    modelUid: modelUid || "",
    provider: selectedTarget.provider || "",
    upstreamModel: selectedTarget.model || "",
  });
}
```

Call `_recordAgentRoute(callOpts, modelUid, selectedTarget)` inside the `if (ok)` block immediately before `return true`. For builtin stub success, record `builtin-stub/stub-transport-test`. Before the terminal all-failed return path, call `_agentStatus.finishRequest(_conversationKey)`.

- [ ] **Step 6: Expose narrow router and runtime facades**

Add these router exports:

```js
agentStatusSummary: (key) => (_agentStatus ? _agentStatus.summary(key) : null),
agentStatusList: () => (_agentStatus ? _agentStatus.listSummaries() : []),
agentStatusSubscribe: (listener) =>
  _agentStatus ? _agentStatus.onDidUpdate(listener) : { dispose() {} },
agentStatusSetMode: (key, mode) =>
  _agentStatus ? _agentStatus.setMode(key, mode, _cfg) : null,
agentStatusOptions: () => (_agentStatus ? _agentStatus.options(_cfg) : { enabled: false }),
```

Expose `_prepareAgentStatus` and `_recordAgentRoute` under `router._test`.

Add matching `ExternalApiRuntime` instance methods:

```js
agentStatusList() {
  return this._router && this._router.agentStatusList
    ? this._router.agentStatusList()
    : [];
}

agentStatusSubscribe(listener) {
  return this._router && this._router.agentStatusSubscribe
    ? this._router.agentStatusSubscribe(listener)
    : { dispose() {} };
}

agentStatusSetMode(key, mode) {
  return this._router && this._router.agentStatusSetMode
    ? this._router.agentStatusSetMode(key, mode)
    : null;
}

agentStatusOptions() {
  return this._router && this._router.agentStatusOptions
    ? this._router.agentStatusOptions()
    : { enabled: false, hud: { enabled: false } };
}
```

Also export module-level wrappers `agentStatusList`, `agentStatusSubscribe`, `agentStatusSetMode`, and `agentStatusOptions` through `runtime.js` for tests and origin-host reuse.

- [ ] **Step 7: Run the focused router tests**

```bash
node test/agent-status.test.js
node test/agent-status-router.test.js
```

Expected: both print PASS.

- [ ] **Step 8: Commit only Agent Status router/runtime hunks**

`dao_router.js` is already dirty. Stage only the new require, prepare/record helpers, call sites, facade exports, and `_test` entries:

```bash
git add -p vendor/外接api/core/dao_router.js
git add vendor/外接api/runtime.js test/agent-status-router.test.js
git diff --cached --check
git diff --cached --stat
git commit -m "feat: publish per-session agent route state"
```

Expected: unrelated existing router changes remain unstaged.

### Task 4: Build the pure multi-session HUD controller

**Files:**
- Create: `core/agent_hud.js`
- Create: `test/agent-hud.test.js`

- [ ] **Step 1: Write projection tests first**

Create `test/agent-hud.test.js` with deterministic summaries covering idle, single, multi, pin, stale pin, old versions, and warnings:

```js
"use strict";

const assert = require("node:assert");
const { createAgentHudController } = require("../core/agent_hud.js");

let now = 10_000;
let persistedPin = null;
const hud = createAgentHudController({
  now: () => now,
  activeTtlMs: 2_000,
  staleTtlMs: 8_000,
  readPinnedKey: () => persistedPin,
  writePinnedKey: (key) => { persistedPin = key; },
});

function summary(key, overrides = {}) {
  return {
    key,
    version: 1,
    updatedAt: now,
    mode: "auto",
    activation: { state: "active", reason: "tools", activatedAt: now - 100 },
    activity: { requestInFlight: false, lastUpdateAt: now },
    goal: `Goal ${key}`,
    phase: "exploring",
    todo: { completed: 2, total: 5, current: "inspect" },
    verification: { latestTestStatus: "unknown", blocking: false },
    failures: { maxConsecutive: 0, sameCallStreak: 0, lastToolOk: true, hasLastError: false },
    route: { modelUid: "swe-1-6-slow", provider: "ay", upstreamModel: "gpt-5.6-terra" },
    workspace: "repo",
    ...overrides,
  };
}

assert.strictEqual(hud.project({ globalMode: "invert" }).kind, "idle");
assert.strictEqual(hud.project({ globalMode: "invert" }).agent, null);

hud.update(summary("dao:a"));
let view = hud.project({ globalMode: "invert" });
assert.strictEqual(view.kind, "single");
assert.match(view.dao.text, /slow→ay/);
assert.match(view.agent.text, /exploring/);
assert.match(view.agent.text, /2\/5/);

hud.update(summary("dao:b", { phase: "testing" }));
view = hud.project({ globalMode: "invert" });
assert.strictEqual(view.kind, "multi");
assert.match(view.dao.text, /multi/);
assert.match(view.agent.text, /2 active/);
assert.doesNotMatch(view.agent.text, /exploring|testing/);

hud.setPinned("dao:b");
view = hud.project({ globalMode: "invert" });
assert.strictEqual(view.kind, "pinned");
assert.match(view.agent.text, /testing/);
assert.strictEqual(persistedPin, "dao:b");

hud.update(summary("dao:b", {
  version: 2,
  verification: { latestTestStatus: "failed", blocking: true },
}));
assert.strictEqual(hud.project({ globalMode: "invert" }).agent.warning, true);

hud.update(summary("dao:b", { version: 1, phase: "wrong-old-value" }));
assert.doesNotMatch(hud.project({ globalMode: "invert" }).agent.text, /wrong-old-value/);

now += 8_001;
view = hud.project({ globalMode: "invert" });
assert.strictEqual(view.kind, "idle");
assert.strictEqual(persistedPin, null);
console.log("agent HUD controller: PASS");
```

- [ ] **Step 2: Run the test and verify the controller is missing**

```bash
node test/agent-hud.test.js
```

Expected: FAIL with `Cannot find module '../core/agent_hud.js'`.

- [ ] **Step 3: Implement the controller**

Create `core/agent_hud.js` with these public behaviors:

```js
"use strict";

function hasWarning(summary) {
  const verification = summary.verification || {};
  const failures = summary.failures || {};
  return verification.latestTestStatus === "failed" ||
    verification.blocking === true ||
    Number(failures.sameCallStreak || 0) >= 2 ||
    Number(failures.maxConsecutive || 0) >= 3 ||
    (failures.hasLastError === true && failures.lastToolOk === false);
}

function compactUid(uid) {
  return String(uid || "").replace(/^swe-1-6-/, "");
}

function createAgentHudController(options = {}) {
  const now = options.now || (() => Date.now());
  let activeTtlMs = Math.max(1_000, Number(options.activeTtlMs) || 120_000);
  let staleTtlMs = Math.max(activeTtlMs, Number(options.staleTtlMs) || 7_200_000);
  const sessions = new Map();
  let pinnedKey = (options.readPinnedKey && options.readPinnedKey()) || null;

  function update(summary) {
    if (!summary || !summary.key) return false;
    const previous = sessions.get(summary.key);
    if (previous && Number(summary.version || 0) < Number(previous.version || 0)) return false;
    if (
      previous && Number(summary.version || 0) === Number(previous.version || 0) &&
      Number(summary.updatedAt || 0) < Number(previous.updatedAt || 0)
    ) return false;
    sessions.set(summary.key, { ...summary });
    return true;
  }

  function setPinned(key) {
    pinnedKey = key && sessions.has(key) ? key : null;
    if (options.writePinnedKey) options.writePinnedKey(pinnedKey);
  }

  function configure(next = {}) {
    activeTtlMs = Math.max(1_000, Number(next.activeTtlMs) || activeTtlMs);
    staleTtlMs = Math.max(activeTtlMs, Number(next.staleTtlMs) || staleTtlMs);
  }

  function prune() {
    const current = now();
    for (const [key, value] of sessions) {
      if (current - Number(value.updatedAt || 0) > staleTtlMs) sessions.delete(key);
    }
    if (pinnedKey && !sessions.has(pinnedKey)) setPinned(null);
  }

  function activeSessions() {
    prune();
    const current = now();
    return [...sessions.values()].filter((value) => {
      if (!value.activation || value.activation.state !== "active") return false;
      const activity = value.activity || {};
      return activity.requestInFlight === true ||
        current - Number(activity.lastUpdateAt || value.updatedAt || 0) <= activeTtlMs;
    });
  }

  function detailProjection(value, kind) {
    const todo = value.todo || {};
    const route = value.route || {};
    const provider = route.provisional === true ? "…" : (route.provider || "?");
    const verify = (value.verification || {}).latestTestStatus || "unknown";
    const verifyLabel = verify === "unknown" ? "test?" : verify;
    return {
      kind,
      key: value.key,
      dao: {
        text: `$(circuit-board) Dao · ${compactUid(route.modelUid) || "route"}→${provider}`,
        tooltip: route.provisional === true
          ? `${route.modelUid || "unknown"} → waiting for actual provider`
          : `${route.modelUid || "unknown"} → ${provider}/${route.upstreamModel || "?"}`,
      },
      agent: {
        text: `$(pulse) Agent · ${value.phase || "start"} · ${todo.completed || 0}/${todo.total || 0} · ${verifyLabel}`,
        warning: hasWarning(value),
        tooltip: `${value.goal || "Agent session"}\n${value.workspace || ""}\nmode=${value.mode || "auto"}`,
      },
      sessions: [...sessions.values()],
    };
  }

  function project({ globalMode = "invert" } = {}) {
    const active = activeSessions();
    const pinned = pinnedKey && sessions.get(pinnedKey);
    if (pinned) return detailProjection(pinned, "pinned");
    if (active.length === 1) return detailProjection(active[0], "single");
    if (active.length > 1) {
      const warnings = active.filter(hasWarning).length;
      return {
        kind: "multi",
        key: null,
        dao: { text: "$(circuit-board) Dao · multi", tooltip: `${active.length} active sessions` },
        agent: {
          text: `$(layers) Agent · ${active.length} active · ${warnings} warn`,
          warning: warnings > 0,
          tooltip: "Multiple active sessions; choose one to pin.",
        },
        sessions: [...sessions.values()],
      };
    }
    return {
      kind: "idle",
      key: null,
      dao: { text: `$(circuit-board) Dao Flow · ${globalMode}`, tooltip: "Dao Flow" },
      agent: null,
      sessions: [...sessions.values()],
    };
  }

  return { update, setPinned, configure, project, list: () => [...sessions.values()], prune };
}

module.exports = { createAgentHudController, hasWarning, compactUid };
```

- [ ] **Step 4: Run the controller test**

```bash
node test/agent-hud.test.js
```

Expected: `agent HUD controller: PASS`.

- [ ] **Step 5: Commit the pure controller**

```bash
git add core/agent_hud.js test/agent-hud.test.js
git diff --cached --check
git commit -m "feat: add safe multi-session HUD projection"
```

### Task 5: Add the VS Code status-bar and QuickPick adapter

**Files:**
- Create: `core/agent_hud_vscode.js`
- Create: `test/agent-hud-vscode.test.js`

- [ ] **Step 1: Write a VS Code adapter test with two sessions**

Create `test/agent-hud-vscode.test.js` with this complete deterministic stub and test:

```js
"use strict";

const assert = require("node:assert");
const { createAgentHudVscode } = require("../core/agent_hud_vscode.js");

let now = 20_000;
const items = [];
const quickPickAnswers = [];
const infoMessages = [];
const daoItem = { text: "", tooltip: "", show() {}, hide() {} };

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
        visible: false,
        disposed: false,
        show() { this.visible = true; },
        hide() { this.visible = false; },
        dispose() { this.disposed = true; },
      };
      items.push(item);
      return item;
    },
    async showQuickPick() { return quickPickAnswers.shift(); },
    async showInformationMessage(message) { infoMessages.push(message); },
  },
};

let pinned = null;
const context = {
  workspaceState: {
    get() { return pinned; },
    async update(_key, value) { pinned = value; },
  },
};

function summary(key, overrides = {}) {
  return {
    key,
    version: 1,
    updatedAt: now,
    mode: "auto",
    activation: { state: "active", reason: "tools", activatedAt: now - 100 },
    activity: { requestInFlight: false, lastUpdateAt: now },
    goal: `Goal ${key}`,
    phase: "exploring",
    todo: { completed: 2, total: 5, current: "inspect" },
    verification: { latestTestStatus: "unknown", blocking: false },
    failures: { maxConsecutive: 0, sameCallStreak: 0, lastToolOk: true, hasLastError: false },
    route: { modelUid: "swe-1-6-slow", provider: "ay", upstreamModel: "gpt-5.6-terra" },
    workspace: "repo",
    ...overrides,
  };
}

const listeners = new Set();
const source = {
  values: [],
  modeChanges: [],
  disposed: false,
  agentStatusList() { return this.values.slice(); },
  agentStatusSubscribe(listener) {
    listeners.add(listener);
    return {
      dispose: () => {
        listeners.delete(listener);
        source.disposed = true;
      },
    };
  },
  agentStatusSetMode(key, mode) {
    this.modeChanges.push({ key, mode });
    const previous = this.values.find((value) => value.key === key);
    const next = { ...previous, version: previous.version + 1, updatedAt: ++now, mode };
    this.values = this.values.map((value) => value.key === key ? next : value);
    return next;
  },
  emit(value) {
    this.values = this.values.filter((entry) => entry.key !== value.key).concat(value);
    for (const listener of listeners) listener(value);
  },
};

(async () => {
  const view = createAgentHudVscode(vscode, context, {
    daoItem,
    source,
    globalMode: () => "invert",
    now: () => now,
    activeTtlMs: 2_000,
    staleTtlMs: 8_000,
  });

assert.strictEqual(items.length, 1, "adapter creates only the Agent item; Dao item is injected");
assert.strictEqual(items[0].priority, 99);
assert.strictEqual(items[0].command, "daopp.agentHud");
assert.strictEqual(items[0].visible, false, "idle Auto does not occupy the status bar");

source.emit(summary("dao:a"));
assert.strictEqual(items[0].visible, true);
assert.match(daoItem.text, /slow→ay/);
assert.match(items[0].text, /exploring/);

source.emit(summary("dao:b", { phase: "testing" }));
assert.match(items[0].text, /2 active/);
assert.doesNotMatch(items[0].text, /exploring|testing/);

quickPickAnswers.push({ _key: "dao:a" }, { label: "Set Off", _action: "off" });
await view.open();
assert.strictEqual(source.modeChanges.at(-1).mode, "off");

view.dispose();
assert.strictEqual(items[0].disposed, true);
assert.strictEqual(source.disposed, true);
console.log("agent HUD VS Code adapter: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Run the test and verify the adapter is missing**

```bash
node test/agent-hud-vscode.test.js
```

Expected: FAIL with `Cannot find module '../core/agent_hud_vscode.js'`.

- [ ] **Step 3: Implement the adapter with injected dependencies**

Create `core/agent_hud_vscode.js` with this complete adapter:

```js
"use strict";

const { createAgentHudController } = require("./agent_hud");

function sessionItem(value) {
  const goal = String(value.goal || "Untitled session").replace(/\s+/g, " ").slice(0, 72);
  const todo = value.todo || {};
  return {
    label: goal,
    description: `${value.workspace || "workspace"} · ${value.mode || "auto"}`,
    detail: `${value.phase || "start"} · ${todo.completed || 0}/${todo.total || 0}`,
    _key: value.key,
  };
}

function createAgentHudVscode(vscode, context, options = {}) {
  const daoItem = options.daoItem;
  const commandId = options.commandId || "daopp.agentHud";
  const agentItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  agentItem.command = commandId;
  agentItem.hide();
  let source = null;
  let subscription = null;
  let disposed = false;

  const controller = createAgentHudController({
    now: options.now,
    activeTtlMs: options.activeTtlMs,
    staleTtlMs: options.staleTtlMs,
    readPinnedKey: () => context.workspaceState.get("dao.agentHud.pinnedKey", null),
    writePinnedKey: (key) => context.workspaceState.update("dao.agentHud.pinnedKey", key),
  });

  function refresh() {
    const statusOptions = source && source.agentStatusOptions
      ? source.agentStatusOptions()
      : { enabled: true, hud: { enabled: true } };
    controller.configure((statusOptions && statusOptions.hud) || {});
    if (statusOptions.enabled === false || (statusOptions.hud && statusOptions.hud.enabled === false)) {
      agentItem.hide();
      return false;
    }
    const view = controller.project({
      globalMode: typeof options.globalMode === "function" ? options.globalMode() : "invert",
    });
    if (!view.agent) {
      agentItem.hide();
      return false;
    }
    daoItem.text = view.dao.text;
    daoItem.tooltip = view.dao.tooltip;
    daoItem.show();
    agentItem.text = view.agent.text;
    agentItem.tooltip = view.agent.tooltip;
    agentItem.backgroundColor = view.agent.warning
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    agentItem.show();
    return true;
  }

  function bindSource(nextSource) {
    if (subscription) subscription.dispose();
    subscription = null;
    source = nextSource || null;
    if (!source) {
      agentItem.hide();
      return;
    }
    for (const value of source.agentStatusList()) controller.update(value);
    subscription = source.agentStatusSubscribe((value) => {
      controller.update(value);
      refresh();
    });
    refresh();
  }

  async function open() {
    if (!source) {
      await vscode.window.showInformationMessage("Agent HUD is unavailable until Dao routing starts.");
      return;
    }
    const values = controller.list().sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
    if (!values.length) {
      await vscode.window.showInformationMessage("No Agent HUD sessions yet.");
      return;
    }
    const picked = await vscode.window.showQuickPick(values.map(sessionItem), {
      placeHolder: "Agent HUD · select a conversation",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    const current = values.find((value) => value.key === picked._key);
    if (!current) return;
    const projection = controller.project({ globalMode: "invert" });
    const isPinned = projection.kind === "pinned" && projection.key === current.key;
    const actions = [
      { label: isPinned ? "Unpin" : "Pin to HUD", _action: isPinned ? "unpin" : "pin" },
      { label: "Set Auto", _action: "auto" },
      { label: "Set On", _action: "on" },
      { label: "Set Off", _action: "off" },
      { label: "Show details", _action: "details" },
    ];
    const action = await vscode.window.showQuickPick(actions, {
      placeHolder: `${String(current.goal || "Agent session").slice(0, 60)} · choose action`,
    });
    if (!action) return;
    if (action._action === "pin") controller.setPinned(current.key);
    else if (action._action === "unpin") controller.setPinned(null);
    else if (action._action === "details") {
      const todo = current.todo || {};
      await vscode.window.showInformationMessage(
        `${String(current.goal || "Agent session").slice(0, 120)} · ` +
        `${current.workspace || "workspace"} · ${current.phase || "start"} · ` +
        `${todo.completed || 0}/${todo.total || 0} · mode=${current.mode || "auto"}`,
      );
    } else {
      const updated = source.agentStatusSetMode(current.key, action._action);
      if (updated) controller.update(updated);
    }
    refresh();
  }

  const timer = setInterval(refresh, 2_000);
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    if (subscription) subscription.dispose();
    subscription = null;
    agentItem.dispose();
  }

  const view = { refresh, bindSource, open, dispose, controller };
  bindSource(options.source || null);
  return view;
}

module.exports = { createAgentHudVscode, sessionItem };
```

The adapter deliberately does not register the command; `extension.js` owns defensive command registration through `safeReg`.

- [ ] **Step 4: Run adapter and controller tests**

```bash
node test/agent-hud.test.js
node test/agent-hud-vscode.test.js
```

Expected: both print PASS.

- [ ] **Step 5: Commit the VS Code adapter**

```bash
git add core/agent_hud_vscode.js test/agent-hud-vscode.test.js
git diff --cached --check
git commit -m "feat: add Agent HUD status bar controls"
```

### Task 6: Wire the adapter into the extension without changing layout

**Files:**
- Modify: `extension.js:4014-4022, 4134-4145, 4294-4352, 4870-4948`
- Modify: `package.json:70-176`

- [ ] **Step 1: Add the command contribution test assertion**

Extend `test/agent-hud-vscode.test.js` to load `package.json` and assert:

```js
const pkg = require("../package.json");
assert.strictEqual(
  pkg.contributes.commands.some((entry) => entry.command === "daopp.agentHud"),
  true,
);
```

Run:

```bash
node test/agent-hud-vscode.test.js
```

Expected: FAIL because the command is not contributed yet.

- [ ] **Step 2: Contribute the command**

Add exactly this command object adjacent to `daopp.quickSwitch` in `package.json`:

```json
{
  "command": "daopp.agentHud",
  "title": "Dao Flow: Agent HUD",
  "category": "Dao Flow"
}
```

- [ ] **Step 3: Create and bind the HUD during activation**

Add the module import near the other local core imports:

```js
const { createAgentHudVscode } = require("./core/agent_hud_vscode");
```

Add `_agentHud = null` beside `_statusBarItem`. After creating `_statusBarItem`, create the adapter:

```js
_agentHud = createAgentHudVscode(vscode, ctx, {
  daoItem: _statusBarItem,
  source: null,
  globalMode: () => _cachedMode || "invert",
});
ctx.subscriptions.push(_agentHud);
safeReg(
  () => vscode.commands.registerCommand("daopp.agentHud", () => _agentHud.open()),
  "cmd:agentHud",
);
```

The adapter does not register commands; `extension.js` registers `daopp.agentHud` through `safeReg` and calls the adapter's exposed `open()` method.

- [ ] **Step 4: Bind the running External API runtime**

At the end of successful `tryStartExternalApi`, after `start()` returns:

```js
if (_agentHud) {
  _agentHud.bindSource(_externalApiRuntime);
  _agentHud.refresh();
}
```

Before nulling `_externalApiRuntime` in `tryStopExternalApi`, call `_agentHud.bindSource(null)`.

- [ ] **Step 5: Preserve the legacy Dao item when HUD is idle**

Start `refreshStatusBar` with:

```js
if (_agentHud && _agentHud.refresh()) return;
```

When the HUD projects a session, the adapter owns both texts. When it returns false, the existing global `Dao Flow · 道/官` text and tooltip execute unchanged.

- [ ] **Step 6: Keep Agent HUD reachable while its item is hidden**

Add this first-step QuickPick item to `cmdQuickSwitch` beside the existing full-panel item:

```js
const OPEN_AGENT_HUD = "$(pulse) Agent HUD…";
```

Insert it after the separator. Handle it before route access:

```js
if (routePick.label === OPEN_AGENT_HUD) {
  await vscode.commands.executeCommand("daopp.agentHud");
  return;
}
```

- [ ] **Step 7: Dispose cleanly**

At the beginning of `deactivate`, before stopping the runtime:

```js
if (_agentHud) {
  _agentHud.dispose();
  _agentHud = null;
}
```

The adapter dispose operation must be idempotent because it is also in `ctx.subscriptions`.

- [ ] **Step 8: Run focused extension tests**

```bash
node test/agent-hud-vscode.test.js
node test/term-coexist.test.js
node test/webview-syntax.test.js
```

Expected: all PASS; the existing status item and extension self-test seam remain loadable.

- [ ] **Step 9: Commit only HUD integration hunks**

Both files are already dirty. Use patch staging and review every staged line:

```bash
git add -p extension.js package.json
git diff --cached --check
git diff --cached -- extension.js package.json
git commit -m "feat: wire Agent HUD into Devin status bar"
```

Expected: no unrelated layout, model-unlock, webview, or existing package changes enter the commit.

### Task 7: Add defaults and architecture documentation

**Files:**
- Modify: `vendor/外接api/core/_默认配置.json`
- Modify: `docs/CODE_STRUCTURE.md`

- [ ] **Step 1: Add the default configuration block**

Under `daoRoutes`, add or extend `agentStatus` to exactly:

```json
"agentStatus": {
  "enabled": true,
  "defaultMode": "auto",
  "profile": "auto",
  "softRules": true,
  "auto": {
    "minToolCalls": 3,
    "activateAfterMs": 90000
  },
  "hud": {
    "enabled": true,
    "activeTtlMs": 120000,
    "staleTtlMs": 7200000
  }
}
```

Do not add secrets or provider credentials.

- [ ] **Step 2: Document module ownership**

Add these entries to `docs/CODE_STRUCTURE.md`:

```markdown
- `core/agent_hud.js`: pure multi-session HUD registry, pinning, expiry, and projection rules.
- `core/agent_hud_vscode.js`: VS Code status-bar and QuickPick adapter for Agent HUD.
- `vendor/外接api/core/agent_status.js`: per-conversation trusted execution state and model-facing status snapshots.
```

- [ ] **Step 3: Validate JSON and focused tests**

```bash
node -e 'JSON.parse(require("fs").readFileSync("vendor/外接api/core/_默认配置.json", "utf8")); console.log("default config: PASS")'
node test/agent-status.test.js
node test/agent-hud.test.js
```

Expected: all print PASS.

- [ ] **Step 4: Commit defaults and docs**

```bash
git add vendor/外接api/core/_默认配置.json docs/CODE_STRUCTURE.md
git diff --cached --check
git commit -m "docs: document Agent HUD defaults and boundaries"
```

### Task 8: Run regression, install narrow patches, and complete live acceptance

**Files:**
- Modify live: `~/.devin/extensions/daoflow.dao-flow-9.9.423/extension.js`
- Modify live: `~/.devin/extensions/daoflow.dao-flow-9.9.423/package.json`
- Modify live: `~/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/runtime.js`
- Modify live: `~/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/dao_router.js`
- Replace live with canonical: `~/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/agent_status.js`
- Create live: `~/.devin/extensions/daoflow.dao-flow-9.9.423/core/agent_hud.js`
- Create live: `~/.devin/extensions/daoflow.dao-flow-9.9.423/core/agent_hud_vscode.js`
- Modify external: `~/.codeium/dao-byok/配置.json`
- Modify external: `~/.codeium/dao-byok/HANDOFF.md`

- [ ] **Step 1: Run all focused tests and syntax checks**

```bash
node -c vendor/外接api/core/agent_status.js
node -c core/agent_hud.js
node -c core/agent_hud_vscode.js
node -c vendor/外接api/core/dao_router.js
node -c vendor/外接api/runtime.js
node -c extension.js
node test/agent-status.test.js
node test/agent-status-router.test.js
node test/agent-hud.test.js
node test/agent-hud-vscode.test.js
node test/swe-route-guard.test.js
node test/cache-resilience.test.js
node test/context-strategy.test.js
node test/webview-syntax.test.js
```

Expected: every syntax check exits 0 and every test prints PASS.

- [ ] **Step 2: Run the repository regression suite**

```bash
npm test
```

Expected: exit code 0. If an unrelated pre-existing test fails, record the exact command and prove the same failure occurs on the pre-HUD revision before proceeding.

- [ ] **Step 3: Snapshot live-file hashes before installation**

```bash
shasum ~/.devin/extensions/daoflow.dao-flow-9.9.423/{extension.js,package.json} \
  ~/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/runtime.js \
  ~/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/{dao_router.js,agent_status.js}
```

Save the output in the task notes. This is a rollback audit, not a source commit.

- [ ] **Step 4: Install without overwriting divergent live files**

Use `apply_patch` for equivalent narrow changes in live `extension.js`, `package.json`, `runtime.js`, and `dao_router.js`. Verify each live hunk against the source function, but do not replace these whole files.

For the three canonical new/owned modules, synchronize exact contents and verify:

```bash
cmp core/agent_hud.js ~/.devin/extensions/daoflow.dao-flow-9.9.423/core/agent_hud.js
cmp core/agent_hud_vscode.js ~/.devin/extensions/daoflow.dao-flow-9.9.423/core/agent_hud_vscode.js
cmp vendor/外接api/core/agent_status.js \
  ~/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/agent_status.js
```

Expected: all `cmp` commands exit 0.

- [ ] **Step 5: Update the live user config narrowly**

Use `apply_patch` on the existing `daoRoutes.agentStatus` object in `~/.codeium/dao-byok/配置.json`; preserve all providers, keys, routes, and unrelated settings. Add `defaultMode`, `auto`, and `hud` using the defaults from Task 7.

Validate without printing secrets:

```bash
node - <<'NODE'
const fs = require('fs');
const p = `${process.env.HOME}/.codeium/dao-byok/配置.json`;
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log(JSON.stringify(c.daoRoutes.agentStatus, null, 2));
NODE
```

Expected: only the `agentStatus` subtree is printed and `defaultMode` is `auto`.

- [ ] **Step 6: Reload Devin Window**

Use Devin's `Developer: Reload Window` command. Do not switch Editor Mode or alter the layout. Wait for Dao health to return:

```bash
curl -s http://127.0.0.1:8955/origin/health
```

Expected: healthy JSON and `mode: invert`.

- [ ] **Step 7: Accept short-task and auto-activation behavior**

In a new Local conversation using the UI's only model, `swe-1-6-slow`:

1. Send a short no-tool question and verify the Agent item stays hidden while the Dao item remains.
2. Run a task that produces three tool results and verify Agent appears automatically.
3. Hover both items and verify no full prompt, absolute path, or secret appears.
4. Confirm `_lsp_parsed_dump.json` still reports the same native cascadeId for the activated session.

Expected UI after activation resembles:

```text
Dao · slow→ay    Agent · exploring · 0/0 · test?
```

- [ ] **Step 8: Accept multi-session safety and pinning**

Start a second long-running conversation so two sessions are active within the two-minute TTL. Verify:

```text
Dao · multi    Agent · 2 active · 0 warn
```

The text must not alternate between session phases. Click Agent, select one session by goal/workspace, choose `Pin to HUD`, and verify both Dao and Agent items now display that same session. Unpin and verify the safe aggregate returns.

- [ ] **Step 9: Accept per-session Off and On**

For one selected session:

1. Choose `Set Off`.
2. Send another message in that conversation.
3. Inspect the corresponding `~/.codeium/dao-byok/agent-status/dao:<cascadeId>.json` and outbound dump.
4. Confirm no new `<agent_status>` is injected and the session is absent from active HUD count.
5. Choose `Set On`, send another message, and confirm injection/HUD resume on the next outbound turn.

- [ ] **Step 10: Accept actual failover route reporting**

Use the already-proven reversible loopback failure injection for the first slow-route channel, send one minimal request, and confirm:

- the response succeeds through the next healthy channel;
- the Dao item and session summary report the actual successful provider, not the configured primary;
- all temporary provider/route changes are restored immediately;
- health/routes/settings match their pre-test values.

- [ ] **Step 11: Check persistence integrity and logs**

```bash
find ~/.codeium/dao-byok/agent-status -maxdepth 1 -name '*.tmp' -print
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const dir = `${process.env.HOME}/.codeium/dao-byok/agent-status`;
for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
  JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}
console.log('agent status JSON integrity: PASS');
NODE
rg -n "agent_status|Agent HUD|ALL FAIL|activate" \
  ~/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/bundled-origin/_router_diag.log | tail -n 80
```

Expected: no `.tmp` files, JSON integrity PASS, and no repeated HUD exception.

- [ ] **Step 12: Update the external handoff**

Use `apply_patch` to update `~/.codeium/dao-byok/HANDOFF.md` with:

- Local remains `swe-1-6-slow` because the UI exposes only slow.
- Agent HUD uses session-level Auto/On/Off.
- Auto thresholds and multi-session aggregate/pin behavior.
- Exact focused tests and live evidence.
- Reminder that JavaScript changes require Reload Window.

- [ ] **Step 13: Final repository audit**

```bash
git status --short
git log --oneline -8
git diff --check
```

Expected: the plan's commits are present; unrelated pre-existing user changes remain untouched and unstaged; no Agent HUD work remains uncommitted.

## Self-review result

- Spec coverage: session isolation, Auto/On/Off, short-task dormancy, actual route reporting, safe multi-session aggregation, pinning, warning provenance, privacy, atomic persistence, hot config, live installation, and rollback evidence all map to explicit tasks.
- Placeholder scan: the plan contains no unspecified implementation steps; every behavioral change names an exact file, API, command, test, and expected result. Uses of “Todo” refer to the product field, not unfinished plan text.
- Type consistency: `mode`, `activation.state`, `activity.lastUpdateAt`, `route.upstreamModel`, `route.provisional`, `agentStatusList`, `agentStatusSubscribe`, `agentStatusSetMode`, `agentStatusOptions`, `recordRoute`, `bindSource`, `configure`, `setPinned`, and `project` use the same names across core, router, runtime, adapter, and tests.

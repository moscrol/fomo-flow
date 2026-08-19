# Codex Through Dao Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Codex through Dao to the existing Cockpit sidecar and show truthful, isolated Codex request/cache/loop telemetry in the existing Dao Web HUD.

**Architecture:** Keep Cockpit as the Codex upstream but change Codex's Responses Base URL to Dao's `/codex-hot/v1`. Dao owns provider/request facts; a new read-only rollout adapter owns per-task lifecycle and cache facts. The Web HUD merges both sanitized projections without double counting or heuristic session joins.

**Tech Stack:** Node.js CommonJS, OpenAI Responses/SSE, filesystem JSONL tailing, existing Dao router/reverse proxy, vanilla HTML/CSS/JavaScript, `node:assert` self-tests.

---

## Scope Note

This plan delivers the real-time rollout source first. The approved spec names
OTel as a later compatibility source after this path is stable; an OTLP receiver
is intentionally outside this implementation plan and does not block the
success criteria below.

## File Map

- Modify `vendor/外接api/core/codex_hot_route.js`: reversible Codex config handoff, Cockpit provider import, enable/disable status.
- Modify `test/codex-hot-route.test.js`: handoff, drift refusal, provider import, and secret-redaction regressions.
- Modify `vendor/外接api/core/revproxy.js`: source-aware Codex request observation and committed-attempt accounting.
- Modify `vendor/外接api/runtime.js`: pass observation metadata to router usage.
- Modify `vendor/bundled-origin/source.js`: pass observation metadata and attach the Codex rollout reader to Web HUD inputs.
- Modify `vendor/外接api/core/dao_router.js`: retain sanitized timing/source fields in bounded request samples.
- Modify `test/codex-hot-endpoint.test.js`: streaming/unary/compact source and usage observations.
- Create `core/codex_telemetry.js`: pure, content-blind Codex rollout event reducer.
- Create `core/codex_rollout_source.js`: bounded JSONL discovery, incremental tailing, checkpoints, and health.
- Create `test/codex-telemetry.test.js`: lifecycle/token/privacy reducer tests.
- Create `test/codex-rollout-source.test.js`: partial-line, offset, rotation, truncation, and restart tests.
- Modify `core/web_hud_service.js`: read Codex summaries and source health.
- Modify `core/web_hud_projection.js`: multi-surface sessions, Codex-native task cache, sanitized source health/request timing.
- Modify `test/web-hud-service.test.js`: Codex reader availability and failure isolation.
- Modify `test/web-hud-projection.test.js`: Codex/Devin isolation, no-double-counting, privacy, and retention.
- Modify `ui/web-hud.html`: surface filters, Codex detail facts, request source column.
- Modify `ui/web-hud.js`: render/filter multi-surface data without raw content.
- Modify `ui/web-hud.css`: compact filter/source/status styling and responsive behavior.
- Modify `test/web-hud-client.test.js`: DOM contract, safe rendering, and Codex labels.
- Modify `test/web-hud-http.test.js`: deployed asset/source wiring assertions.

## Dirty Worktree Rule

The repository already contains unrelated user edits, including edits in
`vendor/bundled-origin/source.js`, `vendor/外接api/core/dao_router.js`, and
`vendor/外接api/core/revproxy.js`. Before every commit:

```bash
git diff -- <files touched by this task>
git diff --cached --check
git diff --cached --stat
```

Stage only the new task hunks. For a file that was dirty before this plan, use
`git add -p -- <file>` and reject every unrelated hunk. Never stage the whole
dirty file.

### Task 1: Reversible Codex config handoff

**Files:**
- Modify: `vendor/外接api/core/codex_hot_route.js:9-18,155-370,435-493`
- Modify: `test/codex-hot-route.test.js:1-210`

- [ ] **Step 1: Add failing restore and drift tests**

Append tests that activate the local URL, restore the original Cockpit fields,
verify mode `0600`, and refuse restoration after external drift:

```js
const handoffPath = path.join(temp, "state", "codex-handoff.json");
const activated = codex.patchCodexConfig({
  configPath,
  handoffPath,
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "dao-loopback-secret",
});
assert.strictEqual(activated.ok, true);
assert.strictEqual(fs.statSync(handoffPath).mode & 0o777, 0o600);

const restored = codex.restoreCodexConfig({ configPath, handoffPath });
assert.deepStrictEqual(restored, {
  ok: true,
  changed: true,
  restartRequired: true,
  providerName: "old-provider",
});
assert.strictEqual(codex.readCodexConfigSnapshot(configPath).baseUrl, "https://old.invalid/v1");
assert(fs.readFileSync(configPath, "utf8").includes('experimental_bearer_token = "old-provider-secret"'));

codex.patchCodexConfig({
  configPath,
  handoffPath,
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "dao-loopback-secret",
});
fs.writeFileSync(
  configPath,
  fs.readFileSync(configPath, "utf8").replace(
    'base_url = "http://127.0.0.1:8919/codex-hot/v1"',
    'base_url = "http://127.0.0.1:9999/changed"',
  ),
  "utf8",
);
const refused = codex.restoreCodexConfig({ configPath, handoffPath });
assert.strictEqual(refused.ok, false);
assert.strictEqual(refused.reason, "config-drift");
assert(!JSON.stringify(refused).includes("old-provider-secret"));
```

- [ ] **Step 2: Run the route test and verify RED**

Run:

```bash
node test/codex-hot-route.test.js
```

Expected: FAIL because `restoreCodexConfig` and managed handoff persistence do
not exist.

- [ ] **Step 3: Implement private handoff persistence and restore**

Add these public operations and use them from `patchCodexConfig`:

```js
const HANDOFF_PATH = path.join(
  os.homedir(), ".codeium", "dao-byok", "codex-cockpit-handoff.json",
);

function sha256(value) {
  return require("node:crypto")
    .createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

function readProviderConnection(configPath) {
  const text = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
  const topEnd = firstSection < 0 ? lines.length : firstSection;
  const providerName = String(parseTomlScalar(lines, "model_provider", 0, topEnd) || "");
  const bounds = providerSectionBounds(lines, providerName);
  if (!bounds) throw new Error("Codex provider section not found: " + providerName);
  return {
    providerName,
    model: String(parseTomlScalar(lines, "model", 0, topEnd) || ""),
    baseUrl: String(parseTomlScalar(lines, "base_url", bounds.start, bounds.end) || ""),
    bearerToken: String(parseTomlScalar(lines, "experimental_bearer_token", bounds.start, bounds.end) || ""),
    wireApi: String(parseTomlScalar(lines, "wire_api", bounds.start, bounds.end) || ""),
  };
}

function writePrivateJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
}
```

Persist only once per unmanaged activation:

```js
const handoffPath = options && options.handoffPath || HANDOFF_PATH;
if (!alreadyManaged && !fs.existsSync(handoffPath)) {
  const originalConnection = readProviderConnection(configPath);
  writePrivateJson(handoffPath, {
    version: 1,
    providerName: originalConnection.providerName,
    original: {
      baseUrl: originalConnection.baseUrl,
      bearerToken: originalConnection.bearerToken,
    },
    managed: { baseUrl, bearerTokenHash: sha256(apiKey) },
    activatedAt: Date.now(),
  });
}
```

Implement restore with exact managed-value checks before changing only
`base_url` and `experimental_bearer_token`. Return `config-drift` without any
secret values when either check fails. Export `HANDOFF_PATH`,
`readProviderConnection`, and `restoreCodexConfig`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node test/codex-hot-route.test.js
```

Expected: `codex hot route selftest: PASS`.

- [ ] **Step 5: Commit the reversible handoff**

```bash
git add test/codex-hot-route.test.js vendor/外接api/core/codex_hot_route.js
git diff --cached --check
git commit -m "feat: make codex base url handoff reversible"
```

### Task 2: Import the current Cockpit provider and add enable/disable control

**Files:**
- Modify: `vendor/外接api/core/codex_hot_route.js:372-493`
- Modify: `vendor/bundled-origin/source.js:4528-4578`
- Modify: `test/codex-hot-route.test.js`
- Modify: `test/codex-hot-endpoint.test.js`

- [ ] **Step 1: Write failing provider-import and disable tests**

Use a runtime stub that records `hotSetConfig` and assert the imported provider
is Responses-only and secret-safe:

```js
let importedConfig = null;
const importingRuntime = {
  hotGetConfig() {
    return importedConfig || { providers: {}, daoRoutes: { routes: {} } };
  },
  hotSetConfig(value) {
    importedConfig = {
      providers: { ...(importedConfig && importedConfig.providers || {}), ...value.providers },
      daoRoutes: { routes: {} },
    };
    return { ok: true };
  },
};
const imported = codex.ensureCockpitProvider(importingRuntime, {
  providerName: "codex_local_access",
  model: "gpt-5.6-sol",
  baseUrl: "http://127.0.0.1:57244/v1",
  bearerToken: "cockpit-private-token",
  wireApi: "responses",
});
assert.strictEqual(imported.name, "cockpit-codex");
assert.strictEqual(importedConfig.providers["cockpit-codex"].baseUrl, "http://127.0.0.1:57244/v1");
assert.strictEqual(importedConfig.providers["cockpit-codex"].protocol, "openai-responses");
assert.deepStrictEqual(importedConfig.providers["cockpit-codex"].models, ["gpt-5.6-sol"]);
assert(!JSON.stringify(imported).includes("cockpit-private-token"));
```

Add a source-level dispatch regression to `test/codex-hot-endpoint.test.js`:

```js
assert.match(sourceText, /body\.action === "disable"/);
assert.match(sourceText, /codexMod\.restoreCodexConfig/);
assert.match(sourceText, /codexMod\.apply/);
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node test/codex-hot-route.test.js
node test/codex-hot-endpoint.test.js
```

Expected: FAIL because `ensureCockpitProvider` and action dispatch do not exist.

- [ ] **Step 3: Implement provider import before route normalization**

Add a loopback validator and provider importer:

```js
function ensureCockpitProvider(runtime, connection, name = "cockpit-codex") {
  if (!runtime || typeof runtime.hotSetConfig !== "function") {
    throw new Error("router hot config unavailable");
  }
  const parsed = new URL(connection.baseUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Cockpit provider must use a loopback Base URL");
  }
  if (connection.wireApi && connection.wireApi !== "responses") {
    throw new Error("Cockpit provider wire_api must be responses");
  }
  if (!connection.bearerToken) throw new Error("Cockpit provider token missing");
  const result = runtime.hotSetConfig({
    providers: {
      [name]: {
        label: "Cockpit Codex",
        baseUrl: connection.baseUrl.replace(/\/$/, ""),
        apiKey: connection.bearerToken,
        protocol: "openai-responses",
        streamMode: "stream",
        models: [connection.model || "gpt-5.6-sol"],
      },
    },
  });
  if (!result || result.ok !== true) {
    throw new Error("Cockpit provider import failed: " + String(result && result.error || "unknown"));
  }
  return { ok: true, name, model: connection.model || "gpt-5.6-sol" };
}
```

In `apply`, read/import the current provider before `normalize` when the request
contains `importCurrentProvider: true`. Save only `upstreamImported: true` in
the public route state. Never serialize the Cockpit token.

In `/origin/codex-hot-route`, dispatch actions explicitly:

```js
const result = body.action === "disable"
  ? codexMod.restoreCodexConfig({})
  : codexMod.apply(body, _eaRuntimeMod, _getRevproxy(), _actualPort);
```

- [ ] **Step 4: Run focused route/endpoint tests**

```bash
node test/codex-hot-route.test.js
node test/codex-hot-endpoint.test.js
```

Expected: both print `PASS` and serialized control responses contain no Cockpit
or Dao secret.

- [ ] **Step 5: Commit only the task hunks**

```bash
git add test/codex-hot-route.test.js test/codex-hot-endpoint.test.js vendor/外接api/core/codex_hot_route.js
git add -p -- vendor/bundled-origin/source.js
git diff --cached --check
git commit -m "feat: bridge codex hot route through cockpit"
```

### Task 3: Record source-aware Codex network observations

**Files:**
- Modify: `vendor/外接api/core/revproxy.js:2325-2451,2749-2909`
- Modify: `vendor/外接api/runtime.js:375-383`
- Modify: `vendor/bundled-origin/source.js:10190-10210`
- Modify: `vendor/外接api/core/dao_router.js:2106-2198`
- Modify: `test/codex-hot-endpoint.test.js`

- [ ] **Step 1: Add failing committed-usage assertions**

Capture observation arguments in the endpoint test:

```js
const recordedUsage = [];
const deps = {
  recordUsage(provider, model, usage, observation) {
    recordedUsage.push({ provider, model, usage, observation });
  },
};
```

Merge this function into the existing proxy dependencies, send a streaming
Codex request with `prompt_cache_key: "codex-thread-private"`, and assert:

```js
assert.strictEqual(recordedUsage.length, 1);
assert.strictEqual(recordedUsage[0].provider, "kfcoding");
assert.strictEqual(recordedUsage[0].observation.source, "codex");
assert.match(recordedUsage[0].observation.cacheKeyHash, /^[a-f0-9]{8}$/);
assert(recordedUsage[0].observation.durationMs >= 0);
assert(recordedUsage[0].observation.ttftMs >= 0);
assert.strictEqual(recordedUsage[0].observation.responseToolCount, 0);
assert.strictEqual(recordedUsage[0].observation.success, true);
assert.strictEqual(recordedUsage[0].observation.usageObserved, true);
assert(!JSON.stringify(recordedUsage).includes("codex-thread-private"));
```

Around the reasoning-only retry request, assert exactly one committed record:

```js
const usageBeforeRetry = recordedUsage.length;
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
await retryStreamResponse.text();
assert.strictEqual(recordedUsage.length - usageBeforeRetry, 1);
```

- [ ] **Step 2: Run endpoint test and verify RED**

```bash
node test/codex-hot-endpoint.test.js
```

Expected: FAIL because reverse-proxy usage currently receives only three
arguments and defaults to `source: external`.

- [ ] **Step 3: Add one observation object per Codex request**

In `revproxy.js`, add a private FNV-1a helper compatible with router cache
fingerprints and create the observation after parsing the body:

```js
function _fingerprint(value) {
  const source = String(value || "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const observation = isCodexHot || isCodexHotCompact ? {
  source: "codex",
  startedAt: Date.now(),
  cacheKeyHash: body.prompt_cache_key ? _fingerprint(body.prompt_cache_key) : null,
  reasoningEffort: body.reasoning && body.reasoning.effort || null,
} : { source: "external", startedAt: Date.now() };
```

Pass `observation` into `_bridge`. Track first visible text/tool event, visible
text bytes, tool calls, attempts, and final duration. Move external usage
recording to a guarded `recordCommittedUsage()` called once at terminal end:

```js
function recordCommittedUsage() {
  if (usageRecorded || !committed) return;
  usageRecorded = true;
  deps.recordUsage(target.provName, target.upstreamModel, lastUsage || {}, {
    ...observation,
    ttftMs: firstVisibleAt ? firstVisibleAt - observation.startedAt : 0,
    durationMs: Date.now() - observation.startedAt,
    attemptCount,
    responseToolCount,
    textBytes,
    success: true,
    usageObserved: Boolean(lastUsage),
  });
  if (observation.source === "codex" && deps.markCodexObserved) {
    deps.markCodexObserved({ at: Date.now() });
  }
}
```

On terminal error before a committed response, write one zero-token request
sample with `success: false`, `usageObserved: false`, a normalized
`errorCategory`, and the final duration. This records the failed request without
claiming that zero tokens were authoritatively reported:

```js
function recordTerminalFailure(message) {
  if (usageRecorded) return;
  usageRecorded = true;
  deps.recordUsage(target.provName, target.upstreamModel, {}, {
    ...observation,
    durationMs: Date.now() - observation.startedAt,
    attemptCount,
    success: false,
    usageObserved: false,
    errorCategory: /timeout/i.test(message) ? "timeout" : /401|auth/i.test(message) ? "authentication" : "upstream",
  });
}
```

Change runtime and source forwarding signatures to preserve the fourth
argument:

```js
function routerRecordUsage(providerName, model, tc, observation) {
  const R = _getRouterModule();
  if (R && R.recordUsage) R.recordUsage(providerName, model, tc, observation);
}
```

Extend the bounded router request sample with sanitized numeric fields:

```js
ttftMs: Math.max(0, Number(observation && observation.ttftMs) || 0),
durationMs: Math.max(0, Number(observation && observation.durationMs) || 0),
attemptCount: Math.max(1, Number(observation && observation.attemptCount) || 1),
reasoningEffort: String(observation && observation.reasoningEffort || "").slice(0, 20),
success: observation && observation.success !== false,
usageObserved: observation && observation.usageObserved === true,
errorCategory: String(observation && observation.errorCategory || "").slice(0, 40),
```

Add `markObserved({ at })` to `codex_hot_route.js`; it updates only
`lastObservedAt` and `restartRequired: false` in the hot-route state file. Pass
it through `_revproxyDeps()` as `markCodexObserved` so the flag clears only
after a committed Codex response.

- [ ] **Step 4: Run endpoint, router, and cache tests**

```bash
node test/codex-hot-endpoint.test.js
node vendor/外接api/core/dao-test.js --quick
node test/cache-resilience.test.js
```

Expected: all pass; the empty-response retry records one committed usage sample.

- [ ] **Step 5: Commit only relevant hunks**

```bash
git add test/codex-hot-endpoint.test.js vendor/外接api/runtime.js
git add -p -- vendor/外接api/core/revproxy.js vendor/外接api/core/dao_router.js vendor/bundled-origin/source.js
git diff --cached --check
git commit -m "feat: observe codex responses through dao"
```

### Task 4: Build the content-blind Codex telemetry reducer

**Files:**
- Create: `core/codex_telemetry.js`
- Create: `test/codex-telemetry.test.js`

- [ ] **Step 1: Write reducer lifecycle and privacy tests**

Create fixtures using the real rollout envelope shapes but include sentinel
secrets in content fields:

```js
const store = createCodexTelemetryStore({ now: () => 2_000_000 });
store.ingest({
  timestamp: "2026-07-31T00:00:00.000Z",
  type: "session_meta",
  payload: {
    session_id: "raw-thread-secret",
    cwd: "/Users/alice/private/repo",
    model_provider: "codex_local_access",
    base_instructions: { text: "must-not-escape" },
  },
}, "rollout-a");
store.ingest({ type: "turn_context", payload: {
  turn_id: "raw-turn-secret",
  model: "gpt-5.6-sol",
  effort: "high",
  cwd: "/Users/alice/private/repo",
}}, "rollout-a");
store.ingest({ type: "event_msg", payload: {
  type: "task_started",
  turn_id: "raw-turn-secret",
  started_at: 1_999,
  model_context_window: 353400,
}}, "rollout-a");
store.ingest({ type: "response_item", payload: {
  type: "custom_tool_call",
  name: "exec",
  input: "cat /private/secret",
}}, "rollout-a");
store.ingest({ type: "event_msg", payload: {
  type: "token_count",
  info: {
    last_token_usage: {
      input_tokens: 1000,
      cached_input_tokens: 800,
      cache_write_input_tokens: 0,
      output_tokens: 120,
      reasoning_output_tokens: 40,
      total_tokens: 1120,
    },
    model_context_window: 353400,
  },
}}, "rollout-a");
const summary = store.list()[0];
assert.strictEqual(summary.surface, "codex");
assert.strictEqual(summary.phase, "using-tool");
assert.strictEqual(summary.workspace, "repo");
assert.strictEqual(summary.cache.hitRate, 80);
assert.strictEqual(summary.telemetry.reasoningTokens, 40);
assert.match(summary.key, /^codex:/);
const serialized = JSON.stringify(store.snapshot());
for (const secret of ["raw-thread-secret", "raw-turn-secret", "must-not-escape", "cat /private/secret", "/Users/alice/private"]) {
  assert(!serialized.includes(secret));
}
```

Add explicit completion, failure, compaction, unknown-event, and two-session
assertions:

```js
store.ingest({ type: "event_msg", payload: { type: "context_compacted" } }, "rollout-a");
assert.strictEqual(store.list()[0].telemetry.compactions, 1);
store.ingest({ type: "event_msg", payload: {
  type: "task_complete",
  turn_id: "raw-turn-secret",
  completed_at: 2000,
}}, "rollout-a");
assert.strictEqual(store.list()[0].phase, "completed");
assert.strictEqual(store.list()[0].activity.requestInFlight, false);

store.ingest({ type: "event_msg", payload: { type: "not-a-real-event" } }, "rollout-a");
assert.strictEqual(store.snapshot().health.unknownEvents, 1);

store.ingest({ type: "session_meta", payload: {
  session_id: "second-raw-thread",
  cwd: "/Users/alice/second/repo-b",
  model_provider: "codex_local_access",
}}, "rollout-b");
store.ingest({ type: "event_msg", payload: {
  type: "task_started",
  turn_id: "second-turn",
  started_at: 2001,
}}, "rollout-b");
assert.strictEqual(store.list().length, 2);
assert.notStrictEqual(store.list()[0].key, store.list()[1].key);

const failedStore = createCodexTelemetryStore({ now: () => 2_100_000 });
failedStore.ingest({ type: "session_meta", payload: {
  session_id: "failed-thread",
  cwd: "/tmp/failed-repo",
}}, "failed-rollout");
failedStore.ingest({ type: "event_msg", payload: {
  type: "task_complete",
  error: { message: "private failure detail" },
}}, "failed-rollout");
assert.strictEqual(failedStore.list()[0].phase, "failed");
assert.strictEqual(failedStore.list()[0].failures.hasLastError, true);
assert(!JSON.stringify(failedStore.snapshot()).includes("private failure detail"));
```

- [ ] **Step 2: Run reducer test and verify RED**

```bash
node test/codex-telemetry.test.js
```

Expected: FAIL with `Cannot find module '../core/codex_telemetry.js'`.

- [ ] **Step 3: Implement the pure reducer**

Create a reducer with this public contract and per-rollout context:

```js
const crypto = require("node:crypto");
const path = require("node:path");

function hash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 24);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function emptySession(rawId, timestamp) {
  return {
    rawId,
    key: `codex:${hash(rawId)}`,
    surface: "codex",
    version: 1,
    updatedAt: timestamp,
    observedAt: timestamp,
    activation: { state: "dormant" },
    activity: { requestInFlight: false, lastUpdateAt: timestamp },
    goal: "Codex task",
    phase: "idle",
    todo: { completed: 0, total: 0, current: "" },
    verification: { latestTestStatus: "unknown", blocking: false },
    failures: { maxConsecutive: 0, sameCallStreak: 0, lastToolOk: null, hasLastError: false },
    route: { modelUid: "", provider: "", upstreamModel: "", provisional: true },
    workspace: "",
    cache: { observed: false, calls: 0, input: 0, cached: 0, cacheWrite: 0, hitRate: 0, latestAt: 0 },
    telemetry: {
      reasoningTokens: 0,
      contextWindow: 0,
      compactions: 0,
      toolName: "",
      loopSource: "rollout",
      modelPath: "unknown",
    },
  };
}

function safeSummary(session) {
  const { rawId, ...safe } = session;
  return JSON.parse(JSON.stringify(safe));
}

function createCodexTelemetryStore(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sessions = new Map();
  const sourceSessions = new Map();
  const diagnostics = { lastEventAt: 0, unknownEvents: 0, parseErrors: 0 };

  function ingest(record, sourceId = "default") {
    if (!record || typeof record !== "object") {
      diagnostics.parseErrors += 1;
      return false;
    }
    const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
    const timestamp = Date.parse(record.timestamp || "") || now();
    diagnostics.lastEventAt = Math.max(diagnostics.lastEventAt, timestamp);

    if (record.type === "session_meta" && payload.session_id) {
      const rawId = String(payload.session_id);
      const key = `codex:${hash(rawId)}`;
      sourceSessions.set(sourceId, key);
      const session = sessions.get(key) || emptySession(rawId, timestamp);
      session.workspace = path.basename(String(payload.cwd || "").replace(/\\/g, "/"));
      session.route.provider = String(payload.model_provider || "").slice(0, 100);
      session.updatedAt = timestamp;
      session.version += 1;
      sessions.set(key, session);
      return true;
    }

    const key = sourceSessions.get(sourceId);
    const session = key && sessions.get(key);
    if (!session) {
      diagnostics.unknownEvents += 1;
      return false;
    }

    if (record.type === "turn_context") {
      session.route.modelUid = String(payload.model || "").slice(0, 100);
      session.route.upstreamModel = session.route.modelUid;
      session.telemetry.reasoningEffort = String(payload.effort || "").slice(0, 20);
      session.workspace = path.basename(String(payload.cwd || session.workspace).replace(/\\/g, "/"));
    } else if (record.type === "event_msg" && payload.type === "task_started") {
      session.activation.state = "active";
      session.activity.requestInFlight = true;
      session.phase = "reasoning";
      session.telemetry.contextWindow = number(payload.model_context_window);
    } else if (record.type === "response_item" && payload.type === "custom_tool_call") {
      session.phase = "using-tool";
      session.telemetry.toolName = String(payload.name || "").slice(0, 80);
    } else if (record.type === "response_item" && payload.type === "custom_tool_call_output") {
      session.failures.lastToolOk = true;
      session.phase = "reasoning";
    } else if (record.type === "event_msg" && payload.type === "context_compacted") {
      session.phase = "compacting";
      session.telemetry.compactions += 1;
    } else if (record.type === "event_msg" && payload.type === "token_count") {
      const info = payload.info && typeof payload.info === "object" ? payload.info : {};
      const usage = info.last_token_usage && typeof info.last_token_usage === "object"
        ? info.last_token_usage : {};
      const input = number(usage.input_tokens);
      const cached = number(usage.cached_input_tokens);
      session.cache = {
        observed: true,
        calls: session.cache.calls + 1,
        input,
        cached,
        cacheWrite: number(usage.cache_write_input_tokens),
        hitRate: input ? Math.round(cached / input * 1000) / 10 : 0,
        latestAt: timestamp,
      };
      session.telemetry.reasoningTokens = number(usage.reasoning_output_tokens);
      session.telemetry.contextWindow = number(info.model_context_window) || session.telemetry.contextWindow;
    } else if (record.type === "event_msg" && payload.type === "task_complete") {
      session.activation.state = "dormant";
      session.activity.requestInFlight = false;
      session.phase = payload.error ? "failed" : "completed";
      session.failures.hasLastError = Boolean(payload.error);
      session.telemetry.ttftMs = number(payload.time_to_first_token_ms);
      session.telemetry.durationMs = number(payload.duration_ms);
    } else {
      diagnostics.unknownEvents += 1;
      return false;
    }

    session.updatedAt = timestamp;
    session.observedAt = timestamp;
    session.activity.lastUpdateAt = timestamp;
    session.version += 1;
    return true;
  }

  function list() {
    return [...sessions.values()].map(safeSummary);
  }

  function hydrate(sourceId, summary) {
    if (!summary || !/^codex:[a-f0-9]{24}$/.test(String(summary.key || ""))) return false;
    const restored = JSON.parse(JSON.stringify(summary));
    restored.rawId = "";
    sessions.set(restored.key, restored);
    sourceSessions.set(sourceId, restored.key);
    return true;
  }

  function summaryForSource(sourceId) {
    const key = sourceSessions.get(sourceId);
    return key && sessions.has(key) ? safeSummary(sessions.get(key)) : null;
  }

  function snapshot() {
    const ageMs = diagnostics.lastEventAt ? Math.max(0, now() - diagnostics.lastEventAt) : 0;
    return {
      sessions: list(),
      health: {
        state: diagnostics.parseErrors ? "schema-drift" : diagnostics.lastEventAt ? (ageMs > 120000 ? "stale" : "live") : "off",
        lastEventAt: diagnostics.lastEventAt,
        ageMs,
        unknownEvents: diagnostics.unknownEvents,
        parseErrors: diagnostics.parseErrors,
      },
    };
  }

  return { ingest, hydrate, list, snapshot, summaryForSource };
}

module.exports = { createCodexTelemetryStore };
```

Use SHA-256 to create the internal `key` and retain raw ids only inside closure
state. Allowlist only event type, timestamps, model, effort, workspace basename,
tool name, numeric usage, error presence, and lifecycle flags. Never traverse
or copy message text, instructions, tool input, or tool output.

- [ ] **Step 4: Run reducer test and verify GREEN**

```bash
node test/codex-telemetry.test.js
```

Expected: `codex telemetry: PASS`.

- [ ] **Step 5: Commit reducer and tests**

```bash
git add core/codex_telemetry.js test/codex-telemetry.test.js
git commit -m "feat: normalize codex rollout telemetry"
```

### Task 5: Build the incremental rollout source

**Files:**
- Create: `core/codex_rollout_source.js`
- Create: `test/codex-rollout-source.test.js`

- [ ] **Step 1: Write tailing/checkpoint tests**

Use a temporary `sessions/YYYY/MM/DD` tree and expose a synchronous `poll()`
for deterministic tests:

```js
const source = createCodexRolloutSource({
  sessionsRoot,
  checkpointPath,
  now: () => Date.parse("2026-07-31T01:00:00Z"),
  autoStart: false,
});
fs.writeFileSync(rollout, JSON.stringify(sessionMeta) + "\n" + partialJson, "utf8");
source.poll();
assert.strictEqual(source.list().length, 1);
assert.strictEqual(source.health().parseErrors, 0);

fs.appendFileSync(rollout, partialJsonRemainder + "\n" + JSON.stringify(tokenEvent) + "\n");
source.poll();
assert.strictEqual(source.list()[0].cache.cached, 800);

const restarted = createCodexRolloutSource({
  sessionsRoot,
  checkpointPath,
  now: () => Date.parse("2026-07-31T01:00:05Z"),
  autoStart: false,
});
restarted.poll();
assert.strictEqual(restarted.list().length, 1);
assert.strictEqual(restarted.list()[0].cache.calls, source.list()[0].cache.calls);
assert.strictEqual(fs.statSync(checkpointPath).mode & 0o777, 0o600);
```

Add concrete truncation, rotation, previous-day, malformed-line, bound, and
dispose assertions:

```js
fs.truncateSync(rollout, 0);
fs.writeFileSync(rollout, JSON.stringify(sessionMeta) + "\n" + JSON.stringify(tokenEvent) + "\n");
assert.doesNotThrow(() => source.poll());

const rotated = rollout + ".old";
fs.renameSync(rollout, rotated);
fs.writeFileSync(rollout, JSON.stringify(sessionMeta) + "\n");
assert.doesNotThrow(() => source.poll());

const previousDayDir = path.join(sessionsRoot, "2026", "07", "30");
fs.mkdirSync(previousDayDir, { recursive: true });
fs.writeFileSync(path.join(previousDayDir, "rollout-previous.jsonl"), JSON.stringify(sessionMeta) + "\n");
assert(discoverRecentRollouts(sessionsRoot, Date.parse("2026-07-31T01:00:00Z"), 64)
  .some((file) => file.endsWith("rollout-previous.jsonl")));

fs.appendFileSync(rollout, "{malformed-json}\n");
source.poll();
assert(source.health().parseErrors >= 1);

for (let index = 0; index < 70; index += 1) {
  fs.writeFileSync(path.join(path.dirname(rollout), `rollout-${index}.jsonl`), "", "utf8");
}
assert.strictEqual(
  discoverRecentRollouts(sessionsRoot, Date.parse("2026-07-31T01:00:00Z"), 64).length,
  64,
);
assert.doesNotThrow(() => source.dispose());
assert.doesNotThrow(() => source.dispose());
```

- [ ] **Step 2: Run source test and verify RED**

```bash
node test/codex-rollout-source.test.js
```

Expected: FAIL because the rollout source module does not exist.

- [ ] **Step 3: Implement bounded discovery and byte-offset tailing**

Create the source with this API. The helper functions are part of the same
module and use only checkpoint metadata, never event content:

```js
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCodexTelemetryStore } = require("./codex_telemetry.js");

function pathHash(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 24);
}

function readCheckpoints(target) {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCheckpoints(target, checkpoints) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(checkpoints, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
}

function dateDirectories(root, nowValue) {
  const dates = [new Date(nowValue), new Date(nowValue - 86400000)];
  return dates.map((date) => path.join(
    root,
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ));
}

function discoverRecentRollouts(root, nowValue, limit) {
  const files = [];
  for (const directory of dateDirectories(root, nowValue)) {
    let names = [];
    try { names = fs.readdirSync(directory); } catch { names = []; }
    for (const name of names) {
      if (!/^rollout-.+\.jsonl$/.test(name)) continue;
      const file = path.join(directory, name);
      try { files.push({ file, mtimeMs: fs.statSync(file).mtimeMs }); } catch {}
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit).map((item) => item.file);
}

function createCodexRolloutSource(options = {}) {
  const store = options.store || createCodexTelemetryStore({ now: options.now });
  const sessionsRoot = options.sessionsRoot || path.join(os.homedir(), ".codex", "sessions");
  const checkpointPath = options.checkpointPath || path.join(
    os.homedir(), ".codeium", "dao-byok", "codex-rollout-checkpoints.json",
  );
  const pollMs = Math.max(500, Number(options.pollMs) || 2000);
  const checkpointState = readCheckpoints(checkpointPath);
  const checkpoints = checkpointState.files && typeof checkpointState.files === "object"
    ? checkpointState.files : {};
  let timer = null;

  for (const [sourceId, checkpoint] of Object.entries(checkpoints)) {
    if (checkpoint && checkpoint.summary) store.hydrate(sourceId, checkpoint.summary);
  }

  function tailOneFile(file) {
    const stat = fs.statSync(file);
    const id = pathHash(file);
    const previous = checkpoints[id] || { offset: 0, dev: stat.dev, ino: stat.ino };
    const rotated = previous.dev !== stat.dev || previous.ino !== stat.ino || stat.size < previous.offset;
    const offset = rotated ? 0 : previous.offset;
    if (stat.size === offset) return;
    const length = Math.min(stat.size - offset, 16 * 1024 * 1024);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(length);
    try { fs.readSync(fd, buffer, 0, length, offset); } finally { fs.closeSync(fd); }
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    const processedLength = lastNewline + 1;
    const lines = buffer.subarray(0, processedLength).toString("utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try { store.ingest(JSON.parse(line), id); }
      catch { store.ingest(null, id); }
    }
    checkpoints[id] = {
      offset: offset + processedLength,
      dev: stat.dev,
      ino: stat.ino,
      updatedAt: Date.now(),
      summary: store.summaryForSource(id),
    };
  }

  function poll() {
    const clock = typeof options.now === "function" ? options.now() : Date.now();
    for (const file of discoverRecentRollouts(sessionsRoot, clock, 64)) {
      try { tailOneFile(file); } catch { store.ingest(null, pathHash(file)); }
    }
    writeCheckpoints(checkpointPath, { version: 1, files: checkpoints });
    return store.snapshot();
  }

  function start() {
    if (timer) return;
    poll();
    timer = setInterval(poll, pollMs);
    if (timer.unref) timer.unref();
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  if (options.autoStart !== false) start();
  return { poll, start, dispose, list: store.list, health: () => store.snapshot().health };
}

module.exports = { createCodexRolloutSource, discoverRecentRollouts };
```

Read files as buffers from their saved byte offset, retain incomplete trailing
bytes per file, reset offset when size shrinks, and write only device/inode,
path hash, offset, and update time to the mode-0600 checkpoint file. Do not
persist event content.

- [ ] **Step 4: Run source and reducer tests**

```bash
node test/codex-rollout-source.test.js
node test/codex-telemetry.test.js
```

Expected: both pass without reading files outside the temporary sessions root.

- [ ] **Step 5: Commit the source**

```bash
git add core/codex_rollout_source.js test/codex-rollout-source.test.js
git commit -m "feat: tail codex rollout events safely"
```

### Task 6: Merge Codex tasks into the sanitized HUD projection

**Files:**
- Modify: `core/web_hud_service.js:68-93`
- Modify: `core/web_hud_projection.js:109-236,350-468`
- Modify: `test/web-hud-service.test.js`
- Modify: `test/web-hud-projection.test.js`

- [ ] **Step 1: Add failing multi-surface and no-double-counting tests**

Create a Codex summary with native task cache and pass it separately:

```js
const codexSummary = {
  key: "codex:private-key",
  surface: "codex",
  version: 4,
  updatedAt: now - 10,
  observedAt: now - 10,
  activation: { state: "active" },
  activity: { requestInFlight: true, lastUpdateAt: now - 10 },
  goal: "Codex task",
  phase: "using-tool",
  workspace: "/Users/alice/private/codex-repo",
  route: { modelUid: "gpt-5.6-sol", provider: "cockpit-codex", upstreamModel: "gpt-5.6-sol" },
  cache: { observed: true, calls: 1, input: 1000, cached: 800, cacheWrite: 0, hitRate: 80, latestAt: now - 10 },
  telemetry: { reasoningTokens: 40, contextWindow: 353400, compactions: 1, toolName: "exec" },
};
const mixed = createWebHudSnapshot({
  now,
  agentSummaries: [agent("devin-private")],
  codexSummaries: [codexSummary],
  codexHealth: { state: "live", lastEventAt: now - 10, unknownEvents: 0, parseErrors: 0 },
  codexRoute: { routeActive: true, codexConfigManaged: true, provider: "cockpit-codex", model: "gpt-5.6-sol", restartRequired: false },
  usage: { "cockpit-codex": { calls: 1, input: 1000, output: 120, cached: 800 } },
});
assert.deepStrictEqual(mixed.sessions.map((item) => item.surface).sort(), ["codex", "devin"]);
assert.strictEqual(mixed.sessions.find((item) => item.surface === "codex").cache.hitRate, 80);
assert.strictEqual(mixed.totals.input, 1000, "rollout usage must not be added to routed usage");
assert.strictEqual(mixed.runtime.sources.codex.state, "live");
assert(!JSON.stringify(mixed).includes("codex:private-key"));
```

Assert an Agent Status payload cannot promote itself to the Codex surface:

```js
const spoofed = createWebHudSnapshot({
  now,
  agentSummaries: [agent("spoofed", { surface: "codex" })],
  codexSummaries: [],
});
assert.strictEqual(spoofed.sessions[0].surface, "devin");

const codexRetention = createWebHudSnapshot({
  now,
  codexSummaries: [
    { ...codexSummary, key: "codex:boundary", updatedAt: now - 900000, observedAt: now - 900000,
      activation: { state: "dormant" }, activity: { requestInFlight: false, lastUpdateAt: now - 900000 } },
    { ...codexSummary, key: "codex:expired", updatedAt: now - 900001, observedAt: now - 900001,
      activation: { state: "dormant" }, activity: { requestInFlight: false, lastUpdateAt: now - 900001 } },
  ],
});
assert(codexRetention.sessions.some((session) => session.goal === "Codex task"));
assert.strictEqual(codexRetention.sessions.filter((session) => session.surface === "codex").length, 1);
```

- [ ] **Step 2: Run HUD tests and verify RED**

```bash
node test/web-hud-projection.test.js
node test/web-hud-service.test.js
```

Expected: FAIL because Codex readers and native task cache are not projected.

- [ ] **Step 3: Implement explicit multi-surface projection**

In `web_hud_service.js`, add:

```js
input.codexSummaries = safeRead("codexSummaries", [], combined || input, input.componentWarnings);
input.codexHealth = safeRead("codexHealth", { state: "off" }, combined || input, input.componentWarnings);
input.codexRoute = safeRead("codexRoute", {}, combined || input, input.componentWarnings);
```

In `web_hud_projection.js`, whitelist the surface and preserve a private native
cache until `publicSession`:

```js
const SURFACES = new Set(["devin", "codex"]);
const surface = SURFACES.has(summary.surface) ? summary.surface : "devin";
```

Call `projectSession` with forced source context so arbitrary Agent Status data
cannot self-promote to Codex:

```js
const sessionInputs = [
  ...agentSummaries.map((summary) => ({ summary, surface: "devin" })),
  ...codexSummaries.map((summary) => ({ summary, surface: "codex" })),
];
```

For Codex, sanitize and use `summary.cache`; for Devin, retain the existing
private fingerprint join. Add sanitized `telemetry` numeric fields and
`runtime.sources.codex`. Derive `modelPath` only from the control-plane truth:

```js
const modelPath = codexRoute.codexConfigManaged && codexRoute.routeActive
  ? (codexRoute.restartRequired ? "restart-required" : "routed")
  : codexSummaries.length ? "bypassed" : "unknown";
```

For every Codex session, project the hot route's provider/model and this
`modelPath`; do not infer them from event timing. Keep global totals derived
only from router `usage`.

- [ ] **Step 4: Run all Web HUD data tests**

```bash
node test/web-hud-projection.test.js
node test/web-hud-service.test.js
node test/web-hud-http.test.js
```

Expected: all pass; existing Devin snapshots remain deterministic.

- [ ] **Step 5: Commit the projection**

```bash
git add core/web_hud_service.js core/web_hud_projection.js test/web-hud-service.test.js test/web-hud-projection.test.js
git commit -m "feat: project codex tasks in web hud"
```

### Task 7: Render Codex source, status, and timing in the existing HUD

**Files:**
- Modify: `ui/web-hud.html:37-214`
- Modify: `ui/web-hud.js:3-515`
- Modify: `ui/web-hud.css`
- Modify: `test/web-hud-client.test.js`

- [ ] **Step 1: Add failing client contract assertions**

Add static safety and feature assertions:

```js
for (const id of [
  "surfaceFilters", "detailReasoningTokens", "detailTtft",
  "detailDuration", "detailCompactions", "detailModelPath", "detailLoopSource",
]) assert(html.includes(`id="${id}"`), `missing #${id}`);
assert.match(html, /data-surface-filter="all"/);
assert.match(html, /data-surface-filter="devin"/);
assert.match(html, /data-surface-filter="codex"/);
assert.match(html, /<th scope="col">来源<\/th>/);
assert(js.includes("request.source"));
assert(js.includes("session.telemetry"));
assert(js.includes("state.surfaceFilter"));
assert.doesNotMatch(js, /prompt|assistantText|toolInput|toolOutput/);
assert.doesNotMatch(js, /\.innerHTML\s*=/);
```

- [ ] **Step 2: Run client test and verify RED**

```bash
node test/web-hud-client.test.js
```

Expected: FAIL on missing filters and Codex detail fields.

- [ ] **Step 3: Add source filters and Codex facts**

Add three read-only filter buttons and state:

```js
const state = {
  snapshot: null,
  selectedSessionId: "",
  surfaceFilter: "all",
  source: null,
  failures: 0,
  pollTimer: null,
  retryTimer: null,
  ageTimer: null,
  connection: "connecting",
};

function visibleSessions(snapshot) {
  return list(snapshot.sessions).filter((session) =>
    state.surfaceFilter === "all" || session.surface === state.surfaceFilter,
  );
}

function requestSurface(request) {
  return request && request.source === "codex" ? "codex" : "devin";
}

function visibleRequests(snapshot) {
  return list(snapshot.recentRequests).filter((request) =>
    state.surfaceFilter === "all" || requestSurface(request) === state.surfaceFilter,
  );
}
```

Bind `[data-surface-filter]` buttons after bootstrap, update `aria-pressed`, and
render filtered sessions/recent requests. In detail rendering, use only
sanitized fields:

```js
const telemetry = session.telemetry || {};
setText(elements.detailReasoningTokens, formatTokens(telemetry.reasoningTokens));
setText(elements.detailTtft, telemetry.ttftMs == null ? "—" : `${finite(telemetry.ttftMs)} ms`);
setText(elements.detailDuration, telemetry.durationMs == null ? "—" : `${finite(telemetry.durationMs)} ms`);
setText(elements.detailCompactions, integerNumber.format(finite(telemetry.compactions)));
setText(elements.detailModelPath, copy(telemetry.modelPath, "unknown").toUpperCase());
setText(elements.detailLoopSource, copy(telemetry.loopSource, "unknown").toUpperCase());
```

Add `request.source.toUpperCase()` as the second table cell. Keep all DOM writes
on `textContent`/created text nodes.

- [ ] **Step 4: Run client and projection tests**

```bash
node test/web-hud-client.test.js
node test/web-hud-projection.test.js
```

Expected: both pass; the footer still states no prompts, keys, or full paths.

- [ ] **Step 5: Commit the UI**

```bash
git add ui/web-hud.html ui/web-hud.js ui/web-hud.css test/web-hud-client.test.js
git commit -m "feat: show codex observability in web hud"
```

### Task 8: Wire the rollout source into the live bundled origin

**Files:**
- Modify: `vendor/bundled-origin/source.js:485-525`
- Modify: `test/web-hud-http.test.js`

- [ ] **Step 1: Add failing live-wiring assertions**

Assert the bundled source constructs one rollout reader and exposes both
readers:

```js
assert(sourceText.includes('require(path.join(__dirname, "..", "..", "core", "codex_rollout_source.js"))'));
assert(sourceText.includes("codexSummaries: () => codexSource.list()"));
assert(sourceText.includes("codexHealth: () => codexSource.health()"));
assert(sourceText.includes("codexRoute: () => codexMod.status"));
```

- [ ] **Step 2: Run HTTP test and verify RED**

```bash
node test/web-hud-http.test.js
```

Expected: FAIL because the bundled origin has no Codex rollout reader.

- [ ] **Step 3: Create one lazy source and isolate failures**

Add one module-level source and initialize it only with the HUD:

```js
let _codexRolloutSource = null;
function _ensureCodexRolloutSource() {
  if (_codexRolloutSource) return _codexRolloutSource;
  try {
    const { createCodexRolloutSource } = require(
      path.join(__dirname, "..", "..", "core", "codex_rollout_source.js"),
    );
    _codexRolloutSource = createCodexRolloutSource();
  } catch (error) {
    _eaDiag("codex rollout source unavailable: " + String(error && error.message || error).slice(0, 120));
    _codexRolloutSource = { list: () => [], health: () => ({ state: "unavailable" }), dispose() {} };
  }
  return _codexRolloutSource;
}
```

Inside `_ensureWebHudHandler`, capture `const codexSource =
_ensureCodexRolloutSource()` and add the two readers. Do not let source startup
or polling errors escape into model routing. Add a `codexRoute` reader that
calls `codexMod.status(_actualPort, _eaRuntimeMod.hotGetConfig())` and returns an
empty object on failure.

- [ ] **Step 4: Run HTTP/service/telemetry tests**

```bash
node test/web-hud-http.test.js
node test/web-hud-service.test.js
node test/codex-rollout-source.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit only the live-wiring hunk**

```bash
git add test/web-hud-http.test.js
git add -p -- vendor/bundled-origin/source.js
git diff --cached --check
git commit -m "feat: feed codex telemetry to web hud"
```

### Task 9: Full verification, deployment, and real-chain activation

**Files:**
- Sync changed runtime files to: `/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/`
- Modify at activation time: `/Users/a77/.codeium/dao-byok/配置.json`
- Modify through the control API: `/Users/a77/.codex/config.toml`
- Write private handoff/checkpoints under: `/Users/a77/.codeium/dao-byok/`

- [ ] **Step 1: Run the full focused suite before deployment**

```bash
node test/codex-hot-route.test.js
node test/codex-hot-endpoint.test.js
node test/codex-telemetry.test.js
node test/codex-rollout-source.test.js
node test/web-hud-projection.test.js
node test/web-hud-service.test.js
node test/web-hud-http.test.js
node test/web-hud-client.test.js
node test/cache-resilience.test.js
npm test
```

Expected: every command exits zero. The legacy cache-resilience expectation
must match the repository's current three-failure breaker behavior.

- [ ] **Step 2: Audit privacy and dirty-worktree boundaries**

```bash
git diff --check
git status --short
rg -n "raw-thread-secret|raw-turn-secret|must-not-escape|cockpit-private-token" core ui vendor test
```

Expected: sentinels appear only inside tests; no unrelated dirty file is staged.

- [ ] **Step 3: Sync implementation files to the installed extension**

Copy only the files changed by this plan, preserving the installed tree:

```bash
rsync -a core/codex_telemetry.js core/codex_rollout_source.js core/web_hud_projection.js core/web_hud_service.js /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/core/
rsync -a ui/web-hud.html ui/web-hud.js ui/web-hud.css /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/ui/
rsync -a vendor/bundled-origin/source.js /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/bundled-origin/source.js
rsync -a vendor/外接api/runtime.js /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/runtime.js
rsync -a vendor/外接api/core/codex_hot_route.js vendor/外接api/core/revproxy.js vendor/外接api/core/dao_router.js /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/
```

Expected: source and installed copies have matching SHA-256 hashes.

- [ ] **Step 4: Reload the Devin extension host and verify Dao health**

Use Devin's `Developer: Reload Window`, then run:

```bash
curl -fsS http://127.0.0.1:8955/origin/health | jq '{ok,mode,port}'
curl -fsS http://127.0.0.1:8955/origin/hud/snapshot | jq '{runtime,sources:.runtime.sources}'
```

Expected: Dao is healthy on port 8955 and Codex source health is present even
before Base URL activation.

- [ ] **Step 5: Activate Cockpit import and the Codex Hot Route**

Call the local control endpoint without printing secrets:

```bash
curl -fsS -X POST http://127.0.0.1:8955/origin/codex-hot-route \
  -H 'content-type: application/json' \
  --data '{"action":"enable","importCurrentProvider":true,"provider":"cockpit-codex","model":"gpt-5.6-sol","protocol":"openai-responses","reasoningLevel":"high"}' \
  | jq '{ok,provider:.config.provider,model:.config.model,baseUrl:.config.baseUrl,restartRequired:.codex.restartRequired}'
```

Expected: `ok=true`, provider `cockpit-codex`, model `gpt-5.6-sol`, Base URL
`http://127.0.0.1:8955/codex-hot/v1`, and restart required.

- [ ] **Step 6: Probe Dao -> Cockpit before restarting Codex**

Read the Dao loopback key without echoing it, then call the catalog and one
minimal Responses request:

```bash
DAO_KEY=$(jq -r '.apiKey' "$HOME/.codeium/dao-byok/revproxy.json")
curl -fsS http://127.0.0.1:8955/codex-hot/v1/models \
  -H "authorization: Bearer $DAO_KEY" | jq '{models:[.models[].slug]}'
curl -fsS http://127.0.0.1:8955/codex-hot/v1/responses \
  -H "authorization: Bearer $DAO_KEY" \
  -H 'content-type: application/json' \
  --data '{"model":"gpt-5.6-sol","input":"Reply with OK only.","stream":false,"reasoning":{"effort":"low"}}' \
  | jq '{status,outputTypes:[.output[].type]}'
unset DAO_KEY
```

Expected: model catalog includes `gpt-5.6-sol`; the response completes without
printing answer text or credentials.

- [ ] **Step 7: Restart Codex and perform two-session HUD acceptance**

After Codex restarts, run two tasks that each produce at least two model turns;
one must invoke a local tool. Verify:

```bash
curl -fsS http://127.0.0.1:8955/origin/codex-hot-route \
  | jq '{routeActive,codexConfigManaged,provider,model,restartRequired}'
curl -fsS http://127.0.0.1:8955/origin/hud/snapshot \
  | jq '{codexSessions:[.sessions[]|select(.surface=="codex")|{id,phase,cache,telemetry}],codexRequests:[.recentRequests[]|select(.source=="codex")|{provider,model,hitRate,ttftMs,durationMs}]}'
```

Expected: route active and managed; two distinct Codex session ids; distinct
per-task cache facts; recent requests use `source=codex`; no raw identifiers or
content.

- [ ] **Step 8: Verify reversible disable without executing it permanently**

Use a temporary config fixture in the focused test for destructive restore.
For the live install, verify handoff health only:

```bash
stat -f '%Lp %N' "$HOME/.codeium/dao-byok/codex-cockpit-handoff.json"
curl -fsS http://127.0.0.1:8955/origin/codex-hot-route \
  | jq '{codexConfigManaged,preservation,restartRequired}'
```

Expected: handoff mode `600`, managed state true, no secret fields in output.

- [ ] **Step 9: Final regression and status report**

```bash
npm test
node test/cache-resilience.test.js
git status --short
```

Expected: tests pass; remaining dirty files are the user's pre-existing changes
or explicitly documented implementation hunks, and no required task remains.

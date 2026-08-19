# Request Attempt Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Dao 反代链路增加有界、脱敏的 request/attempt 观测，使失败重试可解释，同时保持 usage、token、缓存和成本只按最终 committed request 计账。

**Architecture:** 沿现有 `revproxy._bridge → dao_router._recordUsage → usage.requests → web_hud_projection` 链路增量实现。`_bridge` 管理一次请求的内部 request/attempt 生命周期；`dao_router` 保持请求级聚合并把 attempt 摘要限制在 8 条；HUD 只投影 provider/model/status/outcome/duration/errorCategory 等安全字段，旧样本仍按 `attemptCount || 1` 兼容。失败或 discarded attempt 的 usage 只保留诊断信息，不进入 provider totals。

**Tech Stack:** Node.js CommonJS、Node built-in `node:test`、现有 HTTP mock upstream、usage ring、Web HUD projection。

---

### Task 1: 先固定 attempt 契约的失败测试

**Files:**
- Modify: `/Users/a77/dao-proxy-pro/test/codex-hot-endpoint.test.js`（在已有透明重试成功和终态失败断言附近）
- Modify: `/Users/a77/dao-proxy-pro/test/web-hud-projection.test.js`（在 `recentRequests` 断言附近）
- Test: 上述两个现有测试文件

- [ ] **Step 1: 为失败后成功的 mock upstream 增加 request/attempt 断言**

在已有 `recordedUsage[0].observation.attemptCount === 2` 的测试后追加以下断言，要求两个 attempt 有序、内部 ID 不同，且只有成功 attempt committed：

```js
const attempts = recordedUsage[0].observation.attempts;
assert.strictEqual(attempts.length, 2);
assert.notStrictEqual(attempts[0].attemptId, attempts[1].attemptId);
assert.strictEqual(attempts[0].attemptIndex, 1);
assert.strictEqual(attempts[1].attemptIndex, 2);
assert.strictEqual(attempts[0].outcome, "discarded");
assert.strictEqual(attempts[1].outcome, "committed");
assert.strictEqual(attempts[1].usageObserved, true);
assert.strictEqual(recordedUsage[0].observation.committedAttemptId, attempts[1].attemptId);
assert(attempts[0].startedAt > 0);
assert(attempts[0].endedAt >= attempts[0].startedAt);
```

在已有首路失败、备路成功的测试（或新增同一 mock server 分支）中追加 HTTP 失败断言：

```js
assert.strictEqual(attempts[0].outcome, "failed");
assert.strictEqual(attempts[0].status, 502);
assert.strictEqual(attempts[0].errorCategory, "upstream");
assert.strictEqual(attempts[0].usageObserved, false);
```

- [ ] **Step 2: 为 HUD projection 增加安全投影断言**

给 `usage` 样本添加只用于测试的内部字段，并断言输出保留安全字段、删除原始 ID 和敏感数据：

```js
const hud = createWebHudSnapshot({
  now,
  usage: {
    mock: {
      requests: [{
        at: now,
        provider: "mock",
        model: "claude-opus-5",
        input: 100,
        output: 2,
        cached: 80,
        attemptCount: 2,
        requestId: "req-secret-internal",
        attempts: [{
          attemptId: "attempt-secret-internal",
          attemptIndex: 1,
          provider: "mock",
          model: "claude-opus-5",
          status: 502,
          outcome: "failed",
          durationMs: 12,
          errorCategory: "upstream",
          prompt: "private prompt",
        }, {
          attemptId: "attempt-committed-internal",
          attemptIndex: 2,
          provider: "mock",
          model: "claude-opus-5",
          status: 200,
          outcome: "committed",
          durationMs: 20,
          errorCategory: "",
        }],
      }],
    },
  },
});
const recent = hud.recentRequests[0];
assert.strictEqual(recent.attemptCount, 2);
assert.deepStrictEqual(recent.attempts.map((item) => item.outcome), ["failed", "committed"]);
assert(!JSON.stringify(recent).includes("req-secret-internal"));
assert(!JSON.stringify(recent).includes("attempt-secret-internal"));
assert(!JSON.stringify(recent).includes("private prompt"));
```

- [ ] **Step 3: 运行新增测试，确认当前实现先失败**

Run:

```bash
node --test ./test/codex-hot-endpoint.test.js ./test/web-hud-projection.test.js
```

Expected: FAIL because `observation.attempts` and the public `recentRequests[].attempts` contract are not yet implemented.

---

### Task 2: 在 revproxy bridge 中创建并结束 request/attempt

**Files:**
- Modify: `/Users/a77/dao-proxy-pro/vendor/外接api/core/revproxy.js:2377-2617`
- Test: `/Users/a77/dao-proxy-pro/test/codex-hot-endpoint.test.js`
- Test: `/Users/a77/dao-proxy-pro/test/revproxy-usage.test.js`

- [ ] **Step 1: 增加有界 ID 和字段规范化辅助函数**

在 `_bridge` 前增加只生成进程内 opaque ID 的 helper；不要把 prompt、cache key 或路径拼入 ID：

```js
function _observationId(prefix, requestId, index) {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${String(requestId).slice(-8)}_${index}_${suffix}`;
}

function _attemptStatus(status) {
  const value = Number(status);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 0;
}

function _boundedAttempts(attempts) {
  return (Array.isArray(attempts) ? attempts : []).slice(-8).map((attempt) => ({
    ...attempt,
    provider: String(attempt.provider || "").slice(0, 100),
    model: String(attempt.model || "").slice(0, 100),
    outcome: ["committed", "failed", "discarded"].includes(attempt.outcome)
      ? attempt.outcome
      : "discarded",
    errorCategory: String(attempt.errorCategory || "").slice(0, 40),
    retryReason: String(attempt.retryReason || "").slice(0, 80),
  }));
}
```

Keep the raw `requestId`/`attemptId` only inside the callback observation used by tests and internal diagnostics; the router/public projection must strip them later.

- [ ] **Step 2: Create one request context and one attempt at each `_dispatch`**

At the start of the returned `_bridge` sink function create one request ID and attempt list:

```js
const requestId = _observationId("req", requestObservation.startedAt, 0);
const attempts = [];
let committedAttemptId = "";
const beginAttempt = (target, index, retryReason) => {
  const attempt = {
    requestId,
    attemptId: _observationId("attempt", requestId, index),
    attemptIndex: index,
    provider: target.provName || target.provider || "upstream",
    model: target.upstreamModel || "?",
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    status: null,
    outcome: "discarded",
    errorCategory: "",
    retryReason: retryReason || "",
    usageObserved: false,
    input: 0,
    output: 0,
    cached: 0,
    cacheWrite: 0,
  };
  attempts.push(attempt);
  if (attempts.length > 8) attempts.shift();
  return attempt;
};
```

Use the current attempt object inside `run(i, emptyRetry)`. Do not reuse `attemptCount` as an ID; `attemptCount` remains the backward-compatible aggregate count.

- [ ] **Step 3: Record open/error/end/commit state without changing response behavior**

Update the current callback handlers as follows:

```js
onOpen: () => {
  if (!attemptHeaderAt) attemptHeaderAt = Date.now();
  lastAttemptHeaderAt = attemptHeaderAt;
  attempt.status = 200;
  sink.onOpen && sink.onOpen();
},
onUsage: (u) => {
  if (u) {
    lastUsage = _mergeUsage(lastUsage, u);
    attempt.usageObserved = true;
    attempt.input = u.input || attempt.input;
    attempt.output = u.output || attempt.output;
    attempt.cached = u.cached || attempt.cached;
    attempt.cacheWrite = u.cacheWrite || attempt.cacheWrite;
  }
  if (committed) sink.onUsage && sink.onUsage(_mergeUsage(null, u));
  else pendingUsage = _mergeUsage(pendingUsage, u);
},
onEnd: () => {
  attempt.endedAt = Date.now();
  attempt.durationMs = Math.max(0, attempt.endedAt - attempt.startedAt);
  if (committed) {
    attempt.outcome = "committed";
    committedAttemptId = attempt.attemptId;
    record(target, true, "");
    sink.onEnd && sink.onEnd();
    return;
  }
  attempt.outcome = "discarded";
  // existing empty retry/fallback control flow remains unchanged
},
onError: (e, status) => {
  attempt.endedAt = Date.now();
  attempt.durationMs = Math.max(0, attempt.endedAt - attempt.startedAt);
  attempt.status = _attemptStatus(status);
  attempt.outcome = "failed";
  attempt.errorCategory = _observationErrorCategory(e);
  // existing fallback control flow remains unchanged
},
```

For an empty/reasoning-only retry, set `retryReason` to `"empty-response"`; for a configured-channel fallback after an error, set it to `"upstream-error"`. The actual retry call remains `run(i, ...)` or `run(i + 1, ...)` so output semantics do not change.

- [ ] **Step 4: Attach the bounded attempt summary to the single request observation**

Extend the existing `deps.recordUsage` observation object without changing its `tc` usage argument:

```js
{
  ...requestObservation,
  requestId,
  committedAttemptId,
  attempts: _boundedAttempts(attempts),
  attemptCount,
  // existing timing, usageObserved, success, and errorCategory fields remain
}
```

Only call `deps.recordUsage` once through the existing `usageRecorded` guard. Failed attempts therefore remain diagnostic and cannot increment router totals.

- [ ] **Step 5: Run the focused bridge tests**

Run:

```bash
node --test ./test/codex-hot-endpoint.test.js ./test/revproxy-usage.test.js
```

Expected: PASS, with exactly one `recordUsage` call for each request and the new attempt assertions green.

---

### Task 3: Persist safe attempt summaries in dao_router without leaking IDs

**Files:**
- Modify: `/Users/a77/dao-proxy-pro/vendor/外接api/core/dao_router.js:2134-2225`
- Test: `/Users/a77/dao-proxy-pro/test/observability-store.test.js` or a new focused router usage assertion in `/Users/a77/dao-proxy-pro/test/codex-hot-endpoint.test.js`

- [ ] **Step 1: Add a router-side public attempt sanitizer**

Before `_recordUsage`, add a helper that removes internal IDs and unknown fields while preserving diagnostic usage:

```js
function _safeAttemptSummary(attempt) {
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) return null;
  const outcome = ["committed", "failed", "discarded"].includes(attempt.outcome)
    ? attempt.outcome
    : "discarded";
  return {
    attemptIndex: Math.max(1, Math.floor(Number(attempt.attemptIndex) || 1)),
    provider: String(attempt.provider || "").slice(0, 100),
    model: String(attempt.model || "").slice(0, 100),
    startedAt: Number.isFinite(Number(attempt.startedAt)) ? Number(attempt.startedAt) : 0,
    endedAt: Number.isFinite(Number(attempt.endedAt)) ? Number(attempt.endedAt) : null,
    durationMs: Number.isFinite(Number(attempt.durationMs)) && Number(attempt.durationMs) >= 0
      ? Number(attempt.durationMs)
      : null,
    status: Number.isInteger(Number(attempt.status)) ? Number(attempt.status) : null,
    outcome,
    errorCategory: String(attempt.errorCategory || "").slice(0, 40),
    retryReason: String(attempt.retryReason || "").slice(0, 80),
    usageObserved: attempt.usageObserved === true,
    input: Math.max(0, Number(attempt.input) || 0),
    output: Math.max(0, Number(attempt.output) || 0),
    cached: Math.max(0, Number(attempt.cached) || 0),
    cacheWrite: Math.max(0, Number(attempt.cacheWrite) || 0),
  };
}
```

Do not copy `requestId`, `attemptId`, prompt, cache key, headers, response content, filesystem paths, or arbitrary input fields into the usage ring.

- [ ] **Step 2: Add sanitized attempts to the request sample**

Add the following fields to the `sample` object in `_recordUsage`:

```js
attemptCount: Math.max(1, Number(observation && observation.attemptCount) || 1),
committedAttempt: Math.max(1, Number(observation && observation.committedAttemptIndex) || 0) || null,
attempts: (Array.isArray(observation && observation.attempts)
  ? observation.attempts
  : [])
  .slice(-8)
  .map(_safeAttemptSummary)
  .filter(Boolean),
```

The router continues to increment `p.calls`, `p.input`, `p.output`, `p.cached`, and model totals exactly once per `_recordUsage` call. No attempt usage is added to those totals.

- [ ] **Step 3: Assert public usage is safe and single-counted**

After the retry endpoint test obtains router usage, assert:

```js
const sample = usage["cockpit-codex"].requests.at(-1);
assert.strictEqual(sample.attempts.length, 2);
assert.strictEqual(sample.attempts[0].outcome, "failed");
assert.strictEqual(sample.attempts[1].outcome, "committed");
assert(!JSON.stringify(sample).includes("requestId"));
assert(!JSON.stringify(sample).includes("attemptId"));
assert.strictEqual(usage["cockpit-codex"].calls, 1);
```

- [ ] **Step 4: Run router and privacy tests**

Run:

```bash
node --test ./test/codex-hot-endpoint.test.js ./test/observability-store.test.js
```

Expected: PASS; aggregate calls/tokens/cache remain unchanged while `requests[].attempts` is present and safe.

---

### Task 4: Project bounded attempt fields into Web HUD recent requests

**Files:**
- Modify: `/Users/a77/dao-proxy-pro/core/web_hud_projection.js:391-479`
- Modify: `/Users/a77/dao-proxy-pro/test/web-hud-projection.test.js`

- [ ] **Step 1: Add projection sanitizer for one attempt**

Add a helper next to `projectLatencySample`:

```js
function projectAttempt(attempt) {
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) return null;
  const outcome = ["committed", "failed", "discarded"].includes(attempt.outcome)
    ? attempt.outcome
    : "discarded";
  return {
    attemptIndex: Math.max(1, integer(attempt.attemptIndex, 1)),
    provider: text(attempt.provider, 100),
    model: text(attempt.model, 100) || "?",
    startedAt: optionalNonnegative(attempt.startedAt),
    endedAt: optionalNonnegative(attempt.endedAt),
    durationMs: optionalNonnegative(attempt.durationMs),
    status: Number.isInteger(attempt.status) ? attempt.status : null,
    outcome,
    errorCategory: text(attempt.errorCategory, 40),
    retryReason: text(attempt.retryReason, 80),
    usageObserved: attempt.usageObserved === true,
    input: optionalNonnegative(attempt.input),
    output: optionalNonnegative(attempt.output),
    cached: optionalNonnegative(attempt.cached),
    cacheWrite: optionalNonnegative(attempt.cacheWrite),
  };
}
```

This is a public DTO (data transfer object, meaning the shape sent to the UI), so it intentionally contains operational facts but no raw identifiers or user content.

- [ ] **Step 2: Add attempts to `projectRequests` with legacy fallback**

Inside each projected request, use:

```js
const attempts = (Array.isArray(sample.attempts) ? sample.attempts : [])
  .slice(-8)
  .map(projectAttempt)
  .filter(Boolean);
```

Add:

```js
attempts,
attemptCount: Math.max(1, integer(sample.attemptCount, attempts.length || 1)),
committedAttempt: integer(sample.committedAttempt, 0) || null,
```

Do not expose `sample.requestId`, `sample.committedAttemptId`, or any raw `attemptId` even if an older/newer producer accidentally includes them.

- [ ] **Step 3: Verify old samples and malformed inputs**

Extend existing malformed/legacy assertions:

```js
const legacyRequest = createWebHudSnapshot({
  now,
  usage: { legacy: { requests: [{ at: now, provider: "legacy", model: "m", attemptCount: 3 }] } },
}).recentRequests[0];
assert.deepStrictEqual(legacyRequest.attempts, []);
assert.strictEqual(legacyRequest.attemptCount, 3);
```

Also assert that invalid `attempts: "bad"`, negative durations, and oversized strings do not throw or escape the field bounds.

- [ ] **Step 4: Run HUD projection tests**

Run:

```bash
node --test ./test/web-hud-projection.test.js ./test/web-hud-client.test.js ./test/web-hud-http.test.js
```

Expected: PASS; existing HUD shape stays backward compatible and the new attempt details are bounded and sanitized.

---

### Task 5: Integrate task view without duplicating network accounting

**Files:**
- Modify: `/Users/a77/dao-proxy-pro/core/task_api.js` only if its recent-request response needs the new safe DTO; otherwise leave unchanged
- Modify: `/Users/a77/dao-proxy-pro/core/task_store.js` only if task-level attempts are currently missing the bounded fields
- Test: `/Users/a77/dao-proxy-pro/test/task-api.test.js`
- Test: `/Users/a77/dao-proxy-pro/test/task-store.test.js`

- [ ] **Step 1: Confirm task API uses existing task attempts and does not consume provider usage totals**

Add a test fixture with two task attempts and assert only safe operational fields are returned:

```js
const task = store.create({ jobId: "job-1", source: "codex", workspace: "/private/workspace" });
store.addAttempt(task.jobId, {
  requestId: "private-request-id",
  attemptId: "private-attempt-id",
  provider: "mock",
  model: "model",
  fallbackUsed: true,
  fallbackReason: "upstream-error",
  durationMs: 10,
  errorCategory: "upstream",
});
const publicTask = api.list().tasks[0];
assert.strictEqual(publicTask.attempts[0].provider, "mock");
assert(!JSON.stringify(publicTask).includes("private-request-id"));
assert(!JSON.stringify(publicTask).includes("private-attempt-id"));
```

- [ ] **Step 2: Keep task attempt data separate from provider usage accounting**

If the API currently merges task attempts into `usage`, change only the projection path so it returns task attempts under `tasks[].attempts`; never add their token fields to `usage.calls/input/output/cached`. Add an assertion that the provider totals are unchanged after task API projection.

- [ ] **Step 3: Run task and HUD service tests**

Run:

```bash
node --test ./test/task-api.test.js ./test/task-store.test.js ./test/web-hud-service.test.js
```

Expected: PASS; task-level attempts remain available for task diagnosis and do not double-count network usage.

---

### Task 6: Full regression and production-instance verification

**Files:**
- No new source files
- Verify: all files changed by Tasks 1-5

- [ ] **Step 1: Run focused regression suite**

Run:

```bash
node --test ./test/codex-hot-endpoint.test.js ./test/codex-hot-route.test.js ./test/revproxy-usage.test.js ./test/observability-store.test.js ./test/web-hud-projection.test.js ./test/web-hud-client.test.js ./test/web-hud-http.test.js ./test/task-api.test.js ./test/task-store.test.js
```

Expected: all tests pass; the retry-success case has two ordered attempts and exactly one committed usage summary.

- [ ] **Step 2: Run the repository test command without touching protected configuration**

Inspect `package.json` scripts first, then run the existing test command (for this repository, use the declared Node test script rather than inventing a new runner). Do not edit `.env*`, provider credentials, or security policies to make tests pass.

Expected: no new failures attributable to request/attempt observability.

- [ ] **Step 3: Verify the running instance with redacted API output**

Use the already running local `8955` instance and an existing local key without printing it. Check `/origin/ea/status`, `/origin/ea/usage`, and the relevant HUD/API endpoint. Validate only these facts:

```text
- request/attempt fields are present where the new code is loaded;
- public JSON contains no requestId, attemptId, prompt, cache key, credential, or workspace path;
- one retry-success request increases calls/tokens once;
- failed/discarded attempts are visible only as bounded diagnostics;
- cached/input/output totals are not duplicated.
```

If the resident process version predates the changes, report “代码已验证，常驻实例未重载” and do not treat the live output as production proof. Restart/reload is a deployment side effect and requires explicit user approval before performing it.

- [ ] **Step 4: Review the final diff without reverting unrelated user changes**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Confirm no prohibited files are staged or modified by this plan (`.env*`, credentials, PDF/DB/archive files, caches, virtual environments). Do not commit or merge to `main` without explicit user instruction.

---

## Self-Review Checklist

- [x] Spec coverage: request ID, bounded attempts, committed-only accounting, privacy, legacy compatibility, HUD projection, task view, retry regression, and live-instance boundary are all covered.
- [x] No placeholder implementation steps: every code change specifies the file, insertion point, concrete fields, and test command.
- [x] Type/field consistency: `attemptCount`, `attempts`, `committedAttempt`, `outcome`, `usageObserved`, and bounded error fields use the same names across bridge, router, HUD, and tests.
- [x] Scope: no event bus, database, new dependency, or large UI is introduced; the plan stays within the approved incremental architecture.

Plan complete and saved to `docs/superpowers/plans/2026-08-03-request-attempt-observability.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using checkpoints.

Which approach?
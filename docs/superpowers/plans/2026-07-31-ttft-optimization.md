# Dao TTFT Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure real first-visible-token latency, show cache-aware p50/p95 in the Dao Web HUD, and conservatively prefer lower-tail-latency channels without changing reasoning quality or duplicating requests.

**Architecture:** A new pure statistics module converts bounded sanitized request samples into deterministic TTFT distributions. Reverse-proxy and Devin-router paths emit one shared timing schema; the existing channel scorer consumes observed first-visible latency, while the HUD projects and renders percentiles without prompt content or raw identifiers.

**Tech Stack:** Node.js CommonJS, OpenAI Responses/SSE, existing Dao router/reverse proxy, vanilla HTML/CSS/JavaScript, `node:assert` self-tests.

---

## File Map

- Create `core/ttft_metrics.js`: pure percentile, cache-bucket, and latency-summary functions.
- Create `test/ttft-metrics.test.js`: deterministic percentile, missing-value, and privacy tests.
- Modify `vendor/外接api/core/revproxy.js`: request/attempt clocks and committed timing observations.
- Modify `test/codex-hot-endpoint.test.js`: Codex text/tool/retry/failure timing behavior.
- Modify `vendor/外接api/core/dao_router.js`: populate real first-visible and total latency for Devin routes.
- Modify `vendor/外接api/core/channel_scorer.js`: p50/p95 metrics and minimum-sample latency scoring.
- Modify `test/feature-coverage.test.js`: scorer neutrality, p95 ranking, and sticky-order integration.
- Modify `core/web_hud_projection.js`: sanitized global/provider latency summaries and timing fields.
- Modify `test/web-hud-projection.test.js`: cache-aware percentiles, no-double-counting, and privacy.
- Modify `ui/web-hud.html`: provider/request TTFT labels and columns.
- Modify `ui/web-hud.js`: missing-safe latency rendering.
- Modify `ui/web-hud.css`: compact latency metric styles.
- Modify `test/web-hud-client.test.js`: DOM contract and content-blind rendering checks.

## Dirty Worktree Rule

`vendor/外接api/core/revproxy.js`, `vendor/外接api/core/dao_router.js`, and several UI/runtime files already contain unrelated user edits. Before every commit:

```bash
git diff -- <task-files>
git diff --cached --check
git diff --cached --stat
```

Use `git add -p` for every previously dirty file and reject keepalive, request-guard, adaptive-thinking, unrelated routing, and other pre-existing hunks.

### Task 1: Build deterministic TTFT statistics

**Files:**
- Create: `core/ttft_metrics.js`
- Create: `test/ttft-metrics.test.js`

- [ ] **Step 1: Write the failing public-interface test**

Create `test/ttft-metrics.test.js`:

```js
"use strict";

const assert = require("node:assert");
const { nearestRank, summarizeSamples } = require("../core/ttft_metrics.js");

assert.strictEqual(nearestRank([400, 100, 300, 200], 0.5), 200);
assert.strictEqual(nearestRank([400, 100, 300, 200], 0.95), 400);
assert.strictEqual(nearestRank([], 0.95), null);

const summary = summarizeSamples([
  { success: true, firstSignalKind: "text", ttftMs: 100, durationMs: 900, cached: 80, input: 100 },
  { success: true, firstSignalKind: "tool", ttftMs: 200, durationMs: 1000, cached: 0, input: 100 },
  { success: true, firstSignalKind: "text", ttftMs: 400, durationMs: 1200, cached: 50, input: 100 },
  { success: false, firstSignalKind: "none", ttftMs: 0, durationMs: 2000, cached: 0, input: 0 },
  { success: true, firstSignalKind: "none", ttftMs: 0, durationMs: 100, cached: 0, input: 0 },
]);
assert.deepStrictEqual(summary.overall, {
  count: 3, p50TtftMs: 200, p95TtftMs: 400, minTtftMs: 100, maxTtftMs: 400,
  p50DurationMs: 1000, p95DurationMs: 1200,
});
assert.strictEqual(summary.cache.hit.count, 2);
assert.strictEqual(summary.cache.hit.p95TtftMs, 400);
assert.strictEqual(summary.cache.miss.count, 1);
assert.strictEqual(summary.cache.miss.p95TtftMs, 200);
assert.strictEqual(summary.cache.unknown.count, 0);
assert(!JSON.stringify(summary).includes("prompt"));

console.log("ttft metrics: PASS");
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node test/ttft-metrics.test.js
```

Expected: fail with `Cannot find module '../core/ttft_metrics.js'`.

- [ ] **Step 3: Implement the pure module**

Create `core/ttft_metrics.js` with this public contract:

```js
"use strict";

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function nearestRank(values, quantile) {
  const sorted = (Array.isArray(values) ? values : [])
    .map(finite).filter((value) => value != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil(Math.min(1, Math.max(0, quantile)) * sorted.length));
  return sorted[rank - 1];
}

function observed(sample) {
  return sample && sample.success !== false &&
    (sample.firstSignalKind === "text" || sample.firstSignalKind === "tool") &&
    finite(sample.ttftMs) != null;
}

function summarize(values) {
  const samples = values.filter(observed);
  const ttft = samples.map((sample) => finite(sample.ttftMs));
  const duration = samples.map((sample) => finite(sample.durationMs)).filter((value) => value != null);
  return {
    count: samples.length,
    p50TtftMs: nearestRank(ttft, 0.5),
    p95TtftMs: nearestRank(ttft, 0.95),
    minTtftMs: ttft.length ? Math.min(...ttft) : null,
    maxTtftMs: ttft.length ? Math.max(...ttft) : null,
    p50DurationMs: nearestRank(duration, 0.5),
    p95DurationMs: nearestRank(duration, 0.95),
  };
}

function bucket(sample) {
  const input = finite(sample && sample.input);
  const cached = finite(sample && sample.cached);
  if (input == null || input === 0 || cached == null) return "unknown";
  return cached > 0 ? "hit" : "miss";
}

function summarizeSamples(values) {
  const samples = Array.isArray(values) ? values.filter((item) => item && typeof item === "object") : [];
  return {
    overall: summarize(samples),
    cache: {
      hit: summarize(samples.filter((sample) => bucket(sample) === "hit")),
      miss: summarize(samples.filter((sample) => bucket(sample) === "miss")),
      unknown: summarize(samples.filter((sample) => bucket(sample) === "unknown")),
    },
  };
}

module.exports = { nearestRank, summarizeSamples };
```

- [ ] **Step 4: Run the test and verify GREEN**

Run `node test/ttft-metrics.test.js`.

Expected: `ttft metrics: PASS`.

- [ ] **Step 5: Commit**

```bash
git add core/ttft_metrics.js test/ttft-metrics.test.js
git commit -m "feat: aggregate ttft percentiles"
```

### Task 2: Emit truthful segmented timing from the reverse proxy

**Files:**
- Modify: `vendor/外接api/core/revproxy.js:2320-2530,2830-2895`
- Modify: `test/codex-hot-endpoint.test.js:180-330`

- [ ] **Step 1: Add failing Codex timing assertions**

Extend the successful text request assertion:

```js
const timing = recordedUsage[0].observation;
assert.strictEqual(timing.firstSignalKind, "text");
assert(timing.daoDispatchMs >= 0);
assert(timing.upstreamHeaderMs >= 0);
assert(timing.upstreamSemanticMs >= timing.upstreamHeaderMs);
assert(timing.retryOverheadMs >= 0);
assert.strictEqual(timing.ttftObserved, true);
```

For a tool-only fixture, assert `firstSignalKind === "tool"`. For the
reasoning-only retry, assert `attemptCount === 2` and
`retryOverheadMs > 0`. For the terminal empty failure, assert:

```js
assert.strictEqual(failed.observation.firstSignalKind, "none");
assert.strictEqual(failed.observation.ttftObserved, false);
assert.strictEqual(failed.observation.ttftMs, null);
assert(failed.observation.durationMs >= 0);
```

- [ ] **Step 2: Run the endpoint test and verify RED**

Run `node test/codex-hot-endpoint.test.js`.

Expected: fail on missing segmented timing fields.

- [ ] **Step 3: Add request and attempt clocks**

In `handle`, capture `requestAcceptedAt` immediately before reading a model
request body and set `requestObservation.startedAt = requestAcceptedAt`.

Inside `_bridge`, keep attempt-local state:

```js
let firstAttemptStartedAt = 0;
let committedAttemptStartedAt = 0;
let committedHeaderAt = 0;
let firstVisibleAt = 0;
let firstSignalKind = "none";

const observeVisible = (kind) => {
  if (!firstVisibleAt) {
    firstVisibleAt = Date.now();
    firstSignalKind = kind === "tool" ? "tool" : "text";
  }
};
```

At each `run`, set an attempt start. Capture header arrival in `onOpen`, call
`observeVisible("text")` only for non-whitespace visible text, and
`observeVisible("tool")` for tool starts/calls. When an attempt commits, retain
its start/header clocks.

The terminal observation uses:

```js
const ttftObserved = firstVisibleAt > 0;
const daoDispatchMs = firstAttemptStartedAt
  ? Math.max(0, firstAttemptStartedAt - requestObservation.startedAt) : 0;
const upstreamHeaderMs = committedHeaderAt && committedAttemptStartedAt
  ? Math.max(0, committedHeaderAt - committedAttemptStartedAt) : null;
const upstreamSemanticMs = ttftObserved && committedAttemptStartedAt
  ? Math.max(0, firstVisibleAt - committedAttemptStartedAt) : null;
const ttftMs = ttftObserved
  ? Math.max(0, firstVisibleAt - requestObservation.startedAt) : null;
const retryOverheadMs = ttftObserved && upstreamSemanticMs != null
  ? Math.max(0, ttftMs - daoDispatchMs - upstreamSemanticMs) : 0;
```

Reasoning and keepalive callbacks never call `observeVisible`.

- [ ] **Step 4: Run endpoint and cache tests**

```bash
node test/codex-hot-endpoint.test.js
node test/cache-resilience.test.js
```

Expected: both pass.

- [ ] **Step 5: Commit only task hunks**

```bash
git add test/codex-hot-endpoint.test.js
git add -p -- vendor/外接api/core/revproxy.js
git diff --cached --check
git commit -m "feat: segment reverse proxy ttft"
```

### Task 3: Close the Devin router/scorer latency loop

**Files:**
- Modify: `vendor/外接api/core/dao_router.js:3520-3810,3950-4225,6020-6865`
- Modify: `vendor/外接api/core/channel_scorer.js:42-205,280-305`
- Modify: `test/feature-coverage.test.js:190-235`

- [ ] **Step 1: Add failing scorer tests**

Add tests that record two samples and assert neutral latency, then a third and
assert percentile-driven ranking:

```js
scorer.clearMetrics();
scorer.recordSuccess("cold", "m", 100, 500);
scorer.recordSuccess("cold", "m", 9000, 9500);
assert.strictEqual(scorer.getMetrics("cold", "m").sampleCount, 2);
assert.strictEqual(
  scorer.scoreChannel({ provider: "cold", model: "m" }, { circuits: new Map() }).breakdown.latency,
  0.5,
);
scorer.recordSuccess("cold", "m", 10000, 10500);
scorer.recordSuccess("fast", "m", 500, 1000);
scorer.recordSuccess("fast", "m", 600, 1100);
scorer.recordSuccess("fast", "m", 700, 1200);
const ranked = scorer.rankChannels(
  [{ provider: "cold", model: "m" }, { provider: "fast", model: "m" }],
  { circuits: new Map() },
);
assert.strictEqual(ranked[0].provider, "fast");
assert.strictEqual(scorer.getMetrics("cold", "m").p95TtftMs, 10000);
```

Keep the existing cache-affinity assertion to prove sticky behavior remains
stronger than ordinary scored ordering.

- [ ] **Step 2: Run and verify RED**

Run `node test/feature-coverage.test.js`.

Expected: fail because `sampleCount`, `p50TtftMs`, and `p95TtftMs` are absent
and two samples currently affect latency.

- [ ] **Step 3: Implement minimum-sample percentile scoring**

Add a local nearest-rank helper in `channel_scorer.js`. Extend `getMetrics` and
`metricsSummary` with `sampleCount`, `p50TtftMs`, and `p95TtftMs`. Replace the
average-based latency factor with:

```js
if (m && m.sampleCount >= 3 && m.p95TtftMs > 0) {
  const tail = Math.max(0.05, Math.min(1, 1000 / m.p95TtftMs));
  const center = Math.max(0.05, Math.min(1, 500 / Math.max(1, m.p50TtftMs)));
  breakdown.latency = tail * 0.8 + center * 0.2;
} else {
  breakdown.latency = 0.5;
}
```

- [ ] **Step 4: Populate real Devin first-visible timing**

Before each `_callProvider`, set `callOpts._attemptStartedAt = Date.now()` and
initialize `_requestStartedAt` once. When `_callProvider` returns headers, set
`_upstreamHeaderMs`. Inside `_streamOaToCascade`, define:

```js
const markFirstVisible = (kind) => {
  if (!workspaceContext || workspaceContext._firstVisibleAt) return;
  workspaceContext._firstVisibleAt = Date.now();
  workspaceContext._firstSignalKind = kind;
  workspaceContext._ttfbMs = Math.max(
    0,
    workspaceContext._firstVisibleAt - workspaceContext._attemptStartedAt,
  );
};
```

Call it for visible text and completed/flushable tool calls, never for metadata,
reasoning, or heartbeats. Before `recordSuccess`, set `_totalMs` from
`_requestStartedAt`. Copy the segmented fields into `_cacheObservation` before
`_recordUsage`.

- [ ] **Step 5: Run router, scorer, and cache regressions**

```bash
node test/feature-coverage.test.js
node vendor/外接api/core/dao-test.js --quick
node test/cache-resilience.test.js
```

Expected: all pass and existing sticky/circuit behavior is unchanged.

- [ ] **Step 6: Commit only task hunks**

```bash
git add test/feature-coverage.test.js
git add -p -- vendor/外接api/core/channel_scorer.js vendor/外接api/core/dao_router.js
git diff --cached --check
git commit -m "feat: route with observed p95 ttft"
```

### Task 4: Project and render cache-aware latency in Web HUD

**Files:**
- Modify: `core/web_hud_projection.js:260-455,475-540`
- Modify: `test/web-hud-projection.test.js`
- Modify: `ui/web-hud.html:180-245`
- Modify: `ui/web-hud.js:320-500`
- Modify: `ui/web-hud.css`
- Modify: `test/web-hud-client.test.js`

- [ ] **Step 1: Add failing projection assertions**

Add request samples for the same provider with cache-hit TTFT values
`[100, 200, 400]` and cache-miss values `[800, 1200, 2000]`. Assert:

```js
const provider = snapshot.providers.find((item) => item.id === "cockpit-codex");
assert.strictEqual(provider.latency.overall.p50TtftMs, 400);
assert.strictEqual(provider.latency.overall.p95TtftMs, 2000);
assert.strictEqual(provider.latency.cache.hit.p95TtftMs, 400);
assert.strictEqual(provider.latency.cache.miss.p95TtftMs, 2000);
assert.strictEqual(snapshot.runtime.latency.overall.count, 6);
assert(!JSON.stringify(snapshot).includes("cacheKeyHash"));
```

Assert recent requests retain only the sanitized timing fields and render
`null` for unavailable timing instead of zero.

- [ ] **Step 2: Run projection test and verify RED**

Run `node test/web-hud-projection.test.js`.

Expected: fail because provider/runtime latency summaries are absent.

- [ ] **Step 3: Add projection summaries**

Import `summarizeSamples` from `./ttft_metrics.js`. Gather all sanitized
provider request arrays once. Add:

```js
latency: summarizeSamples(samples)
```

to each provider, and add `runtime.latency = summarizeSamples(allSamples)`.
Project `daoDispatchMs`, `upstreamHeaderMs`, `upstreamSemanticMs`,
`retryOverheadMs`, `ttftObserved`, and allowlisted `firstSignalKind` on recent
requests. Preserve `null` through projection for unavailable values.

- [ ] **Step 4: Add failing client contract assertions**

Require these IDs/labels in `test/web-hud-client.test.js`:

```js
for (const id of ["detailProviderP50", "detailProviderP95", "detailCacheHitP95", "detailCacheMissP95"])
  assert(html.includes(`id="${id}"`));
assert.match(html, /上游首字/);
assert.match(html, /重试开销/);
assert(js.includes("provider.latency"));
assert(js.includes("request.upstreamSemanticMs"));
assert.doesNotMatch(js, /prompt|assistantText|toolInput|toolOutput/);
```

- [ ] **Step 5: Render provider and request latency**

Add four compact latency facts to the selected task/provider area and columns
for total TTFT, upstream semantic wait, and retry overhead in the recent
request table. Use a helper that renders `—` for `null`/unobserved and `0 ms`
only for a real observed zero.

Do not add client-side percentile calculation; the browser renders the
sanitized projection only.

- [ ] **Step 6: Run all HUD tests**

```bash
node test/web-hud-projection.test.js
node test/web-hud-client.test.js
node test/web-hud-service.test.js
node test/web-hud-http.test.js
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add core/web_hud_projection.js test/web-hud-projection.test.js \
  ui/web-hud.html ui/web-hud.js ui/web-hud.css test/web-hud-client.test.js
git commit -m "feat: show cache-aware ttft in web hud"
```

### Task 5: Full verification and live deployment

**Files:**
- Sync changed runtime/UI files to `/Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/`

- [ ] **Step 1: Run the full focused and repository suites**

```bash
node test/ttft-metrics.test.js
node test/codex-hot-route.test.js
node test/codex-hot-endpoint.test.js
node test/web-hud-projection.test.js
node test/web-hud-client.test.js
node test/cache-resilience.test.js
npm test
```

Expected: every command exits zero.

- [ ] **Step 2: Audit privacy and worktree boundaries**

```bash
git diff --check
git status --short
rg -n "raw prompt|assistantText|toolInput|toolOutput" core ui vendor test
```

Expected: no new content-bearing field crosses the HUD boundary and unrelated
dirty files remain unstaged.

- [ ] **Step 3: Sync implementation files**

```bash
rsync -a core/ttft_metrics.js core/web_hud_projection.js \
  /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/core/
rsync -a ui/web-hud.html ui/web-hud.js ui/web-hud.css \
  /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/ui/
rsync -a vendor/外接api/core/revproxy.js vendor/外接api/core/dao_router.js \
  vendor/外接api/core/channel_scorer.js \
  /Users/a77/.devin/extensions/daoflow.dao-flow-9.9.423/vendor/外接api/core/
```

Verify source/installed SHA-256 equality for every file.

- [ ] **Step 4: Restart only the Dao extension host and validate health**

Terminate only the process listening on `127.0.0.1:8955`; allow Devin to
restart its extension host. Verify:

```bash
curl -fsS http://127.0.0.1:8955/origin/health | jq '{ok,mode,port}'
curl -fsS http://127.0.0.1:8955/origin/hud/snapshot \
  | jq '{latency:.runtime.latency,providers:[.providers[]|{id,latency}]}'
```

Expected: Dao is healthy and latency summaries are present without content.

- [ ] **Step 5: Generate at least three real Codex samples**

Run three minimal new Codex CLI tasks through the managed Base URL, using one
cache key naturally supplied by the Codex client. Do not print answer content.
Then verify the HUD contains:

```bash
curl -fsS http://127.0.0.1:8955/origin/hud/snapshot | jq '{
  codex:[.recentRequests[]|select(.source=="codex")|{
    provider,model,ttftMs,upstreamSemanticMs,retryOverheadMs,firstSignalKind
  }],
  provider:[.providers[]|select(.id=="cockpit-codex")|.latency]
}'
```

Expected: at least three observed successful samples, non-null p50/p95, and no
raw request/task/cache identifiers.

- [ ] **Step 6: Browser acceptance**

Reload `http://127.0.0.1:8955/hud` and verify CODEX filtering, provider p50/p95,
cache hit/miss comparison, and timing breakdown columns render without console
errors.

- [ ] **Step 7: Final regression**

Run `npm test`, `node test/cache-resilience.test.js`, and `git status --short`.
Document only the pre-existing unrelated dirty files.

# Web HUD Session Cache and Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show cache metrics attributable to the selected Dao session and automatically remove inactive sessions from the main HUD 15 minutes after their last trusted activity.

**Architecture:** Keep correlation inside the pure Web HUD projection: compute the router-compatible FNV-1a fingerprint from each private Agent Status key, join it to bounded router cache samples, and expose only sanitized aggregates. Apply retention in the same projection using trusted activity timestamps; keep the browser a presentation-only consumer of `session.cache` and `session.lifecycle`.

**Tech Stack:** Node.js CommonJS, browser DOM APIs, `node:assert`, existing Dao Web HUD snapshot/SSE pipeline.

---

## File map

- Modify `core/web_hud_projection.js`: private fingerprinting, session retention, per-session cache aggregation, sanitized snapshot fields.
- Modify `test/web-hud-projection.test.js`: exact attribution, privacy, lifecycle, and 15-minute boundary regressions.
- Modify `ui/web-hud.js`: session cache rendering and recent-session badges/ages.
- Modify `ui/web-hud.html`: distinguish session cache and channel aggregate labels.
- Modify `test/web-hud-client.test.js`: ensure browser code never falls back to provider cache metrics.
- Deploy the changed runtime/UI files to `~/.devin/extensions/daoflow.dao-flow-9.9.423/` and restart/reload the installed Origin runtime.

### Task 1: Lock the projection bug down with regression tests

**Files:**
- Modify: `test/web-hud-projection.test.js`

- [ ] **Step 1: Add a router-compatible fingerprint helper to the fixture**

```js
function cacheFingerprint(value) {
  const source = typeof value === "string" ? value : JSON.stringify(value || null);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
```

- [ ] **Step 2: Add two same-provider sessions with different cache samples**

Create samples with `cacheKeyHash: cacheFingerprint("cascade:secret-a")` and
`cacheKeyHash: cacheFingerprint("cascade:secret-b")`, then assert:

```js
assert.deepStrictEqual(snapshot.sessions[0].cache, {
  observed: true,
  calls: 1,
  input: 500,
  cached: 300,
  cacheWrite: 50,
  hitRate: 60,
  latestAt: now - 100,
});
assert.notStrictEqual(snapshot.sessions[0].cache.hitRate, snapshot.sessions[1].cache.hitRate);
assert(!JSON.stringify(snapshot).includes(cacheFingerprint("cascade:secret-a")));
```

- [ ] **Step 3: Add lifecycle boundary fixtures**

Use inactive sessions at exactly `now - 900_000` and `now - 900_001`, plus an
old session with `mode: "on"`. Assert the boundary session remains with
`lifecycle === "recently-ended"`, the older inactive session is absent, and the
old explicitly active session remains.

- [ ] **Step 4: Run the projection test and verify it fails for the reported bug**

Run:

```bash
node test/web-hud-projection.test.js
```

Expected: FAIL because sessions do not yet expose `cache`/`lifecycle` and old
inactive sessions are not filtered.

### Task 2: Implement session attribution and retention in the projection

**Files:**
- Modify: `core/web_hud_projection.js`
- Test: `test/web-hud-projection.test.js`

- [ ] **Step 1: Add constants and private helpers**

```js
const RECENT_SESSION_TTL_MS = 15 * 60_000;

function cacheFingerprint(value) {
  const source = typeof value === "string" ? value : JSON.stringify(value || null);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function latestActivityAt(summary) {
  const activity = object(summary.activity);
  return Math.max(
    finiteNonnegative(activity.lastRequestAt),
    finiteNonnegative(activity.lastUpdateAt),
    finiteNonnegative(summary.updatedAt),
  );
}
```

- [ ] **Step 2: Preserve only a private correlation field during projection**

Return an internal `_cacheKeyHash: cacheFingerprint(summary.key)` from
`projectSession`, compute `lifecycle` from `active`, and filter sessions by
`latestActivityAt`. Remove `_cacheKeyHash` before the frozen public snapshot is
returned.

- [ ] **Step 3: Aggregate bounded request samples per session**

For each private projected session, select request samples with a matching
`cacheKeyHash`. If `route.provider` is known and not provisional, also require
the provider to match. Sum calls/input/cached/cacheWrite, calculate hit rate
with the existing `hitRate`, and record the maximum sample timestamp. Attach:

```js
session.cache = matches.length ? {
  observed: true,
  calls: matches.length,
  input,
  cached,
  cacheWrite,
  hitRate: hitRate(input, cached),
  latestAt,
} : {
  observed: false,
  calls: 0,
  input: 0,
  cached: 0,
  cacheWrite: 0,
  hitRate: 0,
  latestAt: 0,
};
```

- [ ] **Step 4: Run projection and service regressions**

Run:

```bash
node test/web-hud-projection.test.js
node test/web-hud-service.test.js
```

Expected: both print `PASS`.

- [ ] **Step 5: Commit the projection change**

```bash
git add core/web_hud_projection.js test/web-hud-projection.test.js
git commit -m "fix: isolate web hud cache metrics by session"
```

### Task 3: Render truthful session and provider labels

**Files:**
- Modify: `ui/web-hud.js`
- Modify: `ui/web-hud.html`
- Modify: `test/web-hud-client.test.js`

- [ ] **Step 1: Add failing browser-source assertions**

```js
assert(js.includes("const cache = session.cache || {}"));
assert(js.includes('cache.observed ? formatPercent(cache.hitRate) : "—"'));
assert(js.includes('"暂无会话缓存样本"'));
assert(js.includes('badge("RECENT", "is-warning")'));
assert(!js.includes("provider ? formatPercent(provider.recentHitRate)"));
assert.match(html, /会话缓存/);
assert.match(html, /渠道缓存统计/);
```

- [ ] **Step 2: Run the client test and verify it fails**

Run:

```bash
node test/web-hud-client.test.js
```

Expected: FAIL because the detail view still resolves cache data through the
route provider.

- [ ] **Step 3: Switch the detail renderer to `session.cache`**

Replace the provider lookup with:

```js
const cache = session.cache || {};
setText(elements.detailCacheRate, cache.observed ? formatPercent(cache.hitRate) : "—");
setText(
  elements.detailCacheTokens,
  cache.observed
    ? `${integerNumber.format(finite(cache.calls))} 次 · 读 ${formatTokens(cache.cached)} · 写 ${formatTokens(cache.cacheWrite)}`
    : "暂无会话缓存样本",
);
```

Render a `RECENT` warning badge when
`session.lifecycle === "recently-ended"`; use `latestActivityAt` rather than
`observedAt` for displayed session age and detail freshness.

- [ ] **Step 4: Clarify aggregate labels**

Change the selected-session field label from `渠道缓存` to `会话缓存`, and add
`渠道缓存统计` to the provider panel subtitle without changing the overall
cockpit layout.

- [ ] **Step 5: Run browser and focused HUD tests**

Run:

```bash
node test/web-hud-client.test.js
node test/web-hud-projection.test.js
node test/web-hud-service.test.js
node test/web-hud-http.test.js
```

Expected: all four suites print `PASS`.

- [ ] **Step 6: Commit the UI change**

```bash
git add ui/web-hud.js ui/web-hud.html test/web-hud-client.test.js
git commit -m "fix: render selected-session cache telemetry"
```

### Task 4: Deploy and verify against the live Dao process

**Files:**
- Sync: `core/web_hud_projection.js`
- Sync: `ui/web-hud.js`
- Sync: `ui/web-hud.html`

- [ ] **Step 1: Run repository regressions**

Run the focused Web HUD tests plus the repository's existing prompt-cache
router/resilience commands discovered in `package.json`. Expected: no new
failure; any pre-existing unrelated failure must be reported separately with
its exact command.

- [ ] **Step 2: Copy only the changed runtime assets into the installed extension**

Use the repository's established extension sync method, preserving unrelated
installed files. Verify the copied files with `cmp`.

- [ ] **Step 3: Reload the JavaScript runtime**

Reload the Devin Window or restart the installed Origin process, because both
projection and browser JavaScript changed. Confirm:

```bash
curl -fsS http://127.0.0.1:8955/origin/health
```

Expected: a healthy response from the new process.

- [ ] **Step 4: Verify the live snapshot**

Fetch `/origin/hud/snapshot` and assert that sessions contain `cache.observed`,
that two current GLM sessions report distinct rates when their samples differ,
and that no serialized `cacheKeyHash` appears.

- [ ] **Step 5: Commit deployment metadata only if repository files changed**

Do not commit installed-extension copies. If no additional tracked metadata is
needed, leave the two implementation commits as the complete repository
history for this change.

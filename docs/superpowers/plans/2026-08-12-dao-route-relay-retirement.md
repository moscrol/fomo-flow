# Dao Flow Route Relay and Five-Minute Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the five-minute live-work retirement contract end to end and add a read-only route relay sheet that explains configured priority, skipped channels, circuit cause, and recovery time without automatically changing routing.

**Architecture:** Keep live retirement in the existing source/projection boundaries and treat this work as a regression-verification gate because the production path already enforces five minutes. Enrich the existing pure route planner with a bounded circuit snapshot, project it through the renderer safety model, and render one ordered relay list inside the existing optional preflight result. No new endpoint, IPC method, provider probe, or routing mutation is introduced.

**Tech Stack:** Node.js `node:test`, TypeScript, React 19, Vitest, Testing Library, Electron/Vite.

---

## File map

- `core/web_hud_projection.js`: source-level session freshness contract; verification only.
- `desktop/electron/services/dao-observation-source.ts`: observation boundary and bounded history; verification only.
- `desktop/src/components/work/workLifecycleProjection.ts`: five-minute Current Work retirement; verification only.
- `vendor/外接api/core/route_planner.js`: add safe circuit category and remaining-time facts to excluded relay hops.
- `test/routing-advisory.test.js`: backend red/green contract for order preservation and bounded circuit facts.
- `desktop/src/lib/routeRelay.ts`: isolated safe renderer projection, Chinese circuit labels, and bounded countdown formatting.
- `desktop/src/lib/routeRelay.test.ts`: projection red/green tests.
- `desktop/src/components/control/DecisionCenterControlView.tsx`: render the relay sheet without adding controls that mutate priority.
- `desktop/src/components/control/DecisionCenterControlView.test.tsx`: UI and GET/POST boundary tests.
- `desktop/src/theme/globals.css`: scoped relay-row layout and status styles.
- `desktop/README.md`, `docs/DAO_DESKTOP_PARITY.md`: user-visible capability and boundary notes.

### Task 1: Close the five-minute retirement audit

**Files:**
- Verify: `core/web_hud_projection.js`
- Verify: `desktop/electron/services/dao-observation-source.ts`
- Verify: `desktop/src/components/work/workLifecycleProjection.ts`
- Test: `test/web-hud-projection.test.js`
- Test: `desktop/electron/services/dao-observation-source.test.ts`
- Test: `desktop/src/components/work/workLifecycleProjection.test.ts`
- Test: `desktop/src/components/control/CurrentWorkControlView.test.tsx`

- [x] **Step 1: Run the exact boundary tests**

Run:

```bash
node test/web-hud-projection.test.js
cd desktop && npx vitest run \
  electron/services/dao-observation-source.test.ts \
  src/components/work/workLifecycleProjection.test.ts \
  src/components/control/CurrentWorkControlView.test.tsx
```

Expected: PASS; tests prove `> 5 minutes` retires running and attention facts, missing trusted timestamps do not stay live, and the local one-second clock retires a selected work capsule while HUD refresh is unavailable.

- [x] **Step 2: Check the three thresholds and ordering directly**

Run:

```bash
rg -n "ACTIVE_TTL_MS|STALE_TTL_MS|SESSION_ATTENTION_MS|SESSION_RETIRE_MS|SESSION_FRESH_MS|activityAge" \
  core/web_hud_projection.js \
  desktop/electron/services/dao-observation-source.ts \
  desktop/src/components/work/workLifecycleProjection.ts
```

Expected: Current Work and source active/stale thresholds are five minutes; any 15-minute value is historical retention only; age checks occur before warning/blocked classification.

- [x] **Step 3: Record the audit result without changing working production code**

If Steps 1–2 pass, mark this task complete in this plan. Do not edit lifecycle code merely to create a diff. If a test fails, make the smallest failing-test-first correction only in the layer that violated the contract and rerun Step 1.

### Task 2: Add bounded circuit facts to the route plan

**Files:**
- Modify: `vendor/外接api/core/route_planner.js`
- Test: `test/routing-advisory.test.js`

- [x] **Step 1: Write the failing backend test**

Add a test that creates two configured candidates, opens the first candidate's circuit for 90 seconds, and asserts the configured order is unchanged while only the second candidate remains dispatchable:

```js
test("route relay preserves priority and exposes bounded circuit recovery facts", () => {
  const now = 1_786_332_000_000;
  const candidates = router._test.buildDispatchCandidates(
    {
      provider: "first",
      model: "m1",
      channelStrategy: "priority",
      fallback: { provider: "second", model: "m2" },
    },
    {},
  );
  const plan = router._test.planRoute({
    candidates,
    providers: { first: { enabled: true }, second: { enabled: true } },
    circuits: new Map([
      ["first|m1", { reason: "rate_limit", until: now + 90_000 }],
    ]),
    target: { channelStrategy: "priority" },
    modelUid: "coder",
    profile: "balanced",
    now,
  });

  assert.deepEqual(plan.configuredOrder.map((item) => item.provider), ["first", "second"]);
  assert.deepEqual(plan.dispatchOrder.map((item) => item.provider), ["second"]);
  assert.deepEqual(plan.excluded[0], {
    provider: "first",
    model: "m1",
    source: "primary",
    actualPriority: 1,
    estimatedCostPer1k: null,
    reason: "circuit_open",
    message: "渠道暂时熔断",
    circuitCategory: "rate_limit",
    remainingMs: 90_000,
  });
  assert.equal("until" in plan.excluded[0], false);
});
```

- [x] **Step 2: Run the test to verify RED**

Run:

```bash
node --test --test-name-pattern="route relay preserves" test/routing-advisory.test.js
```

Expected: FAIL because `circuitCategory` and `remainingMs` are not present.

- [x] **Step 3: Add the minimal safe planner projection**

In `route_planner.js`, add a whitelist and bounded helpers, then include the fields only for `circuit_open` exclusions:

```js
const CIRCUIT_CATEGORIES = new Set([
  "authentication",
  "balance",
  "permission",
  "model_not_found",
  "rate_limit",
  "transient",
  "upstream_5xx",
  "network",
]);
const MAX_CIRCUIT_REMAINING_MS = 24 * 60 * 60 * 1000;

function _circuitCategory(value) {
  const normalized = _safeText(value, 40);
  return CIRCUIT_CATEGORIES.has(normalized) ? normalized : "unknown";
}

function _remainingMs(circuit, now) {
  const value = Number(circuit && circuit.until) - now;
  return Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_CIRCUIT_REMAINING_MS, value))
    : null;
}
```

When qualifying a candidate, retain the matched circuit in a local variable and append:

```js
...(reason === "circuit_open"
  ? {
      circuitCategory: _circuitCategory(circuit && circuit.reason),
      remainingMs: _remainingMs(circuit, now),
    }
  : {}),
```

- [x] **Step 4: Run backend tests to verify GREEN**

Run:

```bash
node --test --test-name-pattern="route relay preserves|router planning seam" test/routing-advisory.test.js
node test/routing-advisory.test.js
```

Expected: PASS and configured priority remains unchanged.

- [x] **Step 5: Commit the backend slice**

```bash
git add vendor/外接api/core/route_planner.js test/routing-advisory.test.js
git commit -m "feat: expose safe route relay recovery facts"
```

### Task 3: Project a safe route relay model

**Files:**
- Create: `desktop/src/lib/routeRelay.ts`
- Test: `desktop/src/lib/routeRelay.test.ts`

- [x] **Step 1: Write the failing projection test**

Extend the preflight fixture with a circuit exclusion and assert only whitelisted facts survive:

```ts
expect(result?.excluded[0]).toMatchObject({
  reason: 'circuit_open',
  reasonLabel: '渠道暂时熔断',
  circuitCategory: 'rate_limit',
  circuitLabel: '上游限流',
  remainingMs: 90_000
})
expect(JSON.stringify(result)).not.toContain('SECRET_UPSTREAM_BODY')
```

Add a second assertion that an unknown category becomes `unknown`, a negative/NaN duration becomes `null`, and an oversized duration clamps to 24 hours.

- [x] **Step 2: Run the test to verify RED**

Run:

```bash
cd desktop && npx vitest run src/lib/decisionCenter.test.ts
```

Expected: FAIL because the projected exclusion does not expose the new safe fields.

- [x] **Step 3: Extend the typed projection**

Add these fields to `DecisionExclusion`:

```ts
circuitCategory:
  | 'authentication'
  | 'balance'
  | 'permission'
  | 'model_not_found'
  | 'rate_limit'
  | 'transient'
  | 'upstream_5xx'
  | 'network'
  | 'unknown'
circuitLabel: string
remainingMs: number | null
```

Add a closed label map:

```ts
const CIRCUIT_LABELS = {
  authentication: '凭据需要处理',
  balance: '余额或配额不足',
  permission: '渠道权限不足',
  model_not_found: '上游没有这个模型',
  rate_limit: '上游限流',
  transient: '上游暂时繁忙',
  upstream_5xx: '上游服务异常',
  network: '网络连接失败',
  unknown: '渠道暂时不可用'
} as const
```

Normalize the category through the keys of `CIRCUIT_LABELS`; normalize `remainingMs` as a finite value in `[0, 86_400_000]`; set the fields to `unknown`, an empty label, and `null` for non-circuit exclusions.

- [x] **Step 4: Run projection tests to verify GREEN**

Run:

```bash
cd desktop && npx vitest run src/lib/decisionCenter.test.ts
```

Expected: PASS with no raw body, credentials, path, or identifiers in the projected result.

- [x] **Step 5: Commit the model slice**

```bash
git add desktop/src/lib/decisionCenter.ts desktop/src/lib/decisionCenter.test.ts
git commit -m "feat: project safe route relay state"
```

### Task 4: Render the route relay sheet

**Files:**
- Modify: `desktop/src/components/control/DecisionCenterControlView.tsx`
- Modify: `desktop/src/components/control/DecisionCenterControlView.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write the failing UI test**

Return a preflight where priority #1 is circuit-open and priority #2 is dispatchable. After the user explicitly clicks `查看预计路线`, assert:

```ts
expect(screen.getByRole('heading', { name: '路由接力单' })).toBeInTheDocument()
expect(screen.getByText(/规定 #1.*本次跳过/)).toBeInTheDocument()
expect(screen.getByText('上游限流')).toBeInTheDocument()
expect(screen.getByText('约 1 分 30 秒后可再尝试')).toBeInTheDocument()
expect(screen.getByText(/规定 #2.*预计第一跳/)).toBeInTheDocument()
expect(requestControl).not.toHaveBeenCalledWith(
  expect.any(String),
  expect.stringMatching(/PUT|PATCH|DELETE/),
  expect.anything()
)
```

- [x] **Step 2: Run the UI test to verify RED**

Run:

```bash
cd desktop && npx vitest run src/components/control/DecisionCenterControlView.test.tsx
```

Expected: FAIL because `路由接力单` and recovery copy are absent.

- [x] **Step 3: Implement the ordered relay rows**

Add a pure `RouteRelaySheet` inside `DecisionCenterControlView.tsx`. Iterate `configuredOrder`, find a matching exclusion and dispatch index by provider/model/actualPriority, and render each item once in configured order:

```tsx
<section className="decision-center-relay" aria-labelledby="route-relay-title">
  <h4 id="route-relay-title">路由接力单</h4>
  <ol>
    {preflight.configuredOrder.map((candidate) => (
      <li className={excluded ? 'is-skipped' : 'is-ready'} key={candidateKey(candidate)}>
        <strong>{`规定 #${candidate.actualPriority ?? index + 1} ${candidateName(candidate)}`}</strong>
        <span>{excluded ? '本次跳过' : dispatchIndex === 0 ? '可尝试 · 预计第一跳' : `可尝试 · 后备第 ${dispatchIndex} 跳`}</span>
        {excluded && <small>{excluded.circuitLabel || excluded.reasonLabel}</small>}
        {excluded?.remainingMs != null && <small>{formatRecovery(excluded.remainingMs)}</small>}
      </li>
    ))}
  </ol>
</section>
```

`formatRecovery` must be deterministic and bounded: under 60 seconds uses seconds, otherwise minutes plus remaining seconds, and returns an empty string for `null`.

- [x] **Step 4: Add scoped styles**

Add only `.decision-center-relay*` selectors using existing `--border`, `--surface-low`, `--ink`, `--ink-muted`, `--danger`, and `--success` tokens. Preserve the existing mobile breakpoint and do not change global form/button rules.

- [x] **Step 5: Run UI and safety tests to verify GREEN**

Run:

```bash
cd desktop && npx vitest run \
  src/components/control/DecisionCenterControlView.test.tsx \
  src/lib/decisionCenter.test.ts \
  src/components/control/CurrentWorkControlView.test.tsx
npm run typecheck
npx eslint --quiet \
  src/components/control/DecisionCenterControlView.tsx \
  src/components/control/DecisionCenterControlView.test.tsx \
  src/lib/decisionCenter.ts \
  src/lib/decisionCenter.test.ts
```

Expected: PASS; preflight remains manual and no route priority write is issued.

- [x] **Step 6: Preserve the UI slice without sweeping unrelated dirty work**

The isolated route-relay model and component slices are committed. The integration files already
contained unrelated shared working-tree changes, so their tested integration remains in the working
tree instead of absorbing those changes into this feature's commits.

### Task 5: Document, verify, package, and inspect the real app

**Files:**
- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`
- Modify: `docs/superpowers/plans/2026-08-12-dao-route-relay-retirement.md`

- [x] **Step 1: Document the beginner-facing behavior and boundaries**

Add concise text stating that Current Work retires after five minutes without trusted activity; Route Relay preserves configured priority and only explains readiness, skip cause, recovery time, and actual fallback evidence; it never auto-switches provider/model or performs a health probe.

- [x] **Step 2: Run full verification**

Run:

```bash
node test/routing-advisory.test.js
node test/web-hud-projection.test.js
cd desktop && npm test && npm run typecheck && npm run lint && npm run build
```

Result: root routing/HUD tests pass; Desktop full verification passes 70 files / 286 tests with
`--maxWorkers=1`; typecheck, lint, and production build pass. The bounded worker count avoids known
CPU-contention timeouts in the existing child-process and lazy-import integration tests.

- [x] **Step 3: Build and install the macOS app**

Run the repository's documented macOS packaging command from `desktop`, then replace `/Applications/Dao Flow.app` only after the package succeeds. Preserve any existing user data/configuration directories.

- [x] **Step 4: Inspect the real app**

Open `/Applications/Dao Flow.app`, navigate to `路由观察`, run one explicit preflight against a configured model, and verify the relay rows, skip cause, countdown, and unchanged priority. In `当前工作`, verify no object older than five minutes appears as running or needing attention.

- [x] **Step 5: Mark this plan complete and record the final evidence**

Final evidence:

- installed `/Applications/Dao Flow.app` version `9.9.423` from the fresh arm64 package;
- real preflight showed `fable` as configured priority #1 and `f5` as backup #1 without changing
  priority;
- Current Work showed two live sessions at one and two minutes, zero attention items, and 252
  retired long tasks; older request and Taskboard facts remain only in bounded history/plan sections;
- independent Spec and Quality reviews reported no P0-P3 findings.

Run `git diff --check`, then commit only the plan/spec files; do not sweep shared dirty integration
files into the documentation commit.

```bash
git add \
  docs/superpowers/plans/2026-08-12-dao-route-relay-retirement.md \
  docs/superpowers/specs/2026-08-11-dao-omniroute-relay-retirement-design.md
git commit -m "docs: complete route relay rollout"
```

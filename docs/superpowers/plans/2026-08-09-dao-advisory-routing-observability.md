# Dao Advisory Routing Observability Implementation Plan

> **Implementation record:** completed in the commits listed below; final packaging is tracked separately in section 6.

**Goal:** Add inspectable routing recommendations and explicit request-budget handling to Dao Desktop without changing its configured `priority` routing behavior.

**Architecture:** Keep the router's dispatch strategy unchanged: `priority` traverses the configured channel order and `random` keeps its legacy behavior. A pure routing-profile module supplies scoring lenses; the router records a bounded, sanitized advisory snapshot alongside each request. The existing loopback control API exposes those snapshots, and the desktop shows the current real order separately from the recommendation. Users may manually move a channel to the front in the model editor; no recommendation mutates live routing.

**Tech Stack:** Node.js CommonJS router/runtime, Electron main-process loopback proxy, React + TypeScript + Vitest desktop UI, Node built-in test runner.

---

## Scope invariants

- `channelStrategy: "priority"` must continue trying channels in the user-configured order.
- A recommendation is always marked `advisory`; it must never reorder the dispatch candidate array.
- No snapshot may contain prompts, authorization values, request paths, session identifiers, or raw headers.
- A budget only affects routing when the caller explicitly sends a valid `x-dao-budget-usd` header.
- `budgetFallback=cheapest` is allowed only with an explicit valid budget; otherwise the configured priority remains authoritative.

## 1. Add pure profile and budget primitives

**Files:**

- Create: `vendor/外接api/core/routing_profiles.js`
- Modify: `vendor/外接api/core/channel_scorer.js`
- Create: `test/routing-advisory.test.js`

- [x] Write a dependency-free `routing_profiles.js` that exports `PROFILE_IDS`, `normalizeProfile`, `weightsForProfile`, `parseRequestBudget`, and `estimateRequestCost`.
- [x] Define six normalized lenses: `balanced`, `coding`, `fast`, `cheap`, `reliable`, and `offline`. Each lens covers the scorer's existing eight factors (`health`, `latency`, `cost`, `cacheAffinity`, `stability`, `quota`, `taskFit`, `priority`) and sums to `1`.
- [x] Make invalid or omitted profile names resolve to `balanced`; return frozen copies so callers cannot alter shared weights.
- [x] Parse only explicit `x-dao-budget-usd` values in the safe range `(0, 1000]` and only `strict` or `cheapest` as an explicit `x-dao-budget-fallback`; invalid input returns `null`.
- [x] Make cost estimation return `null` when pricing or token limits are unknown rather than inventing a value.
- [x] Let `channel_scorer.scoreChannel` accept optional profile weights while keeping the current default weights and current callers byte-for-byte compatible in behavior.

```js
// routing_profiles.js public contract
const profile = normalizeProfile("coding"); // "coding"
const weights = weightsForProfile(profile);   // frozen normalized factor map
const budget = parseRequestBudget({
  "x-dao-budget-usd": "0.25",
  "x-dao-budget-fallback": "strict",
}); // { capUsd: 0.25, fallback: "strict" }
```

```js
// channel_scorer.js: preserve defaults for existing call sites
function scoreChannels(candidates, context = {}) {
  const weights = normalizeWeights(context.weights || WEIGHTS);
  // Existing factor calculation, tie-breaking, and return fields remain intact.
}
```

- [x] Add tests proving normalized/frozen weights, unknown-profile fallback, invalid budget rejection, known-price estimation, and that the default scorer result equals the current default-weight result.
- [x] Run `node --test test/routing-advisory.test.js` and expect all assertions to pass.
- [x] Commit with `feat: add routing advisory profile primitives`.

## 2. Record advisory decisions without changing dispatch order

**Files:**

- Modify: `vendor/外接api/core/dao_router.js`
- Modify: `test/routing-advisory.test.js`

- [x] Add a private in-memory decision ring to `dao_router.js`: at most 20 decisions, at most 16 sanitized candidates each, and 30-minute TTL pruning on read/write.
- [x] Build a separate advisory candidate copy after normal candidate construction. Score that copy with the selected profile's weights; retain the original candidate array for dispatch.
- [x] Store only `id`, `at`, normalized profile, actual priority index, provider/model/source labels truncated to 100 characters, rounded factor values, advisory rank/score, budget status, and selected route outcome.
- [x] Implement `getRoutingDecisions(profile, limit)` to prune expired entries, clamp `limit` to `1..20`, recalculate advisory rank from the stored factor vector for the requested profile, and return newest first.
- [x] Export this read function and test-only clearing hook through the router's existing public/test export pattern.
- [x] Record the actual selected candidate on a successful upstream route, and record an exhausted decision with its final failure class when all candidates fail.
- [x] Keep advisory scoring out of dispatch; `priority` also excludes automatic sticky affinity, while legacy `random` keeps its existing shuffle.

```js
// Required priority guard in dao_router.js
const dispatchCandidates = candidates;
const advisoryCandidates = candidates.map(toAdvisoryCandidate);
recordRoutingDecision(buildAdvisoryDecision(advisoryCandidates, context));

// Route only through dispatchCandidates.  Never assign advisoryCandidates back.
for (const candidate of dispatchCandidates) {
  // existing route attempt loop
}
```

- [x] Extend tests to assert that a priority-model snapshot preserves the configured dispatch candidate array even when the `cheap` advisory profile ranks another channel first.
- [x] Extend tests to assert snapshots omit a sentinel prompt, bearer token, path, and session ID when those values are present in the request object.
- [x] Run `node --test test/routing-advisory.test.js` and expect all assertions to pass.
- [x] Commit with `feat: record advisory routing decisions`.

## 3. Enforce only explicit request budgets

**Files:**

- Modify: `vendor/外接api/core/dao_router.js`
- Modify: `test/routing-advisory.test.js`

- [x] Before the dispatch attempt loop, calculate each candidate's estimate from known model pricing and the request token/output bounds.
- [x] With no valid budget header, leave the dispatch candidates untouched and annotate the decision as `not_requested`.
- [x] With `strict`, return HTTP `402` with a protocol-readable `DAO_BUDGET_EXCEEDED` error only when every candidate has a known estimate and every known estimate exceeds the cap; otherwise retain the configured order and mark unknown estimates as `unverified`.
- [x] With explicit `cheapest`, select the least expensive known candidate only when every known candidate exceeds the cap; record both `budget_override: "cheapest"` and `overBudgetFallback: true`. If an estimate is unknown, do not make an automatic budget-driven reorder.
- [x] Add unit coverage for no-header preservation, strict/unknown/cheapest budget decisions; the route path applies the plan before any upstream attempt.
- [x] Run `node --test test/routing-advisory.test.js` and expect all assertions to pass.
- [x] Commit with `feat: add explicit routing request budgets`.

## 4. Expose decisions through the local control API

**Files:**

- Modify: `vendor/外接api/runtime.js`
- Modify: `vendor/bundled-origin/source.js`
- Modify: `desktop/electron/services/dao-control.ts`
- Modify: `desktop/electron/services/dao-control.test.ts`
- Modify: `test/dao-desktop-smoke.test.js`

- [x] Add `routerRoutingDecisions(profile, limit)` to the runtime facade; return an empty array when the active router does not implement the reader so older runtimes remain usable.
- [x] Add `GET /origin/ea/routing-decisions?profile=<id>&limit=<n>` beside the existing observability endpoints. Validate and clamp query values by delegating profile normalization and router limit handling.
- [x] Return `{ ok: true, decisions }` and no request-derived sensitive fields.
- [x] Add the exact `/origin/ea/routing-decisions` path to the Electron control proxy read allowlist. Keep all non-loopback and non-allowlisted protections unchanged.
- [x] Add unit coverage that accepts query strings but rejects a similarly named child path and mutating method.
- [x] Add a smoke assertion that the desktop runtime responds with the decisions envelope.
- [x] Run `node --test test/dao-desktop-smoke.test.js`, `npm test -- dao-control`, and expect all selected tests to pass.
- [x] Commit with `feat: expose routing recommendations locally`.

## 5. Present recommendations and preserve manual control in Desktop

**Files:**

- Create: `desktop/src/lib/routingDecision.ts`
- Create: `desktop/src/components/control/ObservabilityControlView.test.tsx`
- Create: `desktop/src/components/control/CustomModelsControlView.test.tsx`
- Modify: `desktop/src/components/control/ObservabilityControlView.tsx`
- Modify: `desktop/src/components/control/CustomModelsControlView.tsx`

- [x] Add pure UI mappers in `routingDecision.ts` that turn a decision into safe display rows and label current real priority separately from advisory rank. Render unknown values as `—`.
- [x] Extend Observability with `GET /origin/ea/routing-decisions?profile=<selectedProfile>&limit=20`; profile changes refresh only this endpoint.
- [x] Add a profile selector labelled `路由建议 profile`; explain in the panel that changing it only re-scores the display and does not change traffic routing.
- [x] Render a `路由建议` panel with time, actual configured order, recommendation order, score/reason summary, chosen outcome, and budget status. Keep the existing empty/loading/error behavior.
- [x] In Custom Models, add `置顶`/`上移`/`下移` actions for each configured channel. They only rearrange the editor's channel JSON and require `保存并同步` to persist; they send no request on their own.
- [x] Test that Observability renders `实际优先级 #1` distinct from `建议 #1`, profile selection refreshes only the advisory endpoint query, and missing numbers remain unknown.
- [x] Test that manual promotion changes only draft channel order until `保存并同步` is clicked.
- [x] Run `npm test` from `desktop/` (27 files, 54 tests passed).
- [x] Commit with `feat: show advisory routing decisions`.

## 6. Run full regression and document the operator contract

**Files:**

- Modify: `docs/DAO_DESKTOP_PARITY.md`
- Modify: `docs/superpowers/specs/2026-08-09-dao-auto-routing-profile-design.md`

- [x] Add the observed endpoint, profile selector, explicit budget headers, retention limits, and manual-first-channel workflow to the parity/operator documentation.
- [x] State clearly that recommendation ranks are advisory and do not override `priority`; describe the only two exceptions: existing legacy `random` mode and an explicit valid `cheapest` request budget fallback.
- [x] Inspect the changed-file diff for accidental prompt/header persistence or dispatch-order changes; priority sticky insertion and accidental random scoring were corrected.
- [x] Run the root routing/smoke/cache checks and desktop typecheck/lint/test suite.
- [x] Build the desktop package with `npm run build`, `npm run build:electron`, and `npm run dist:mac` from `desktop/`; verify the DMG with `hdiutil` and record its SHA-256.
- [x] Commit the review-corrected implementation and operator documentation (`2419b3b`).

## Acceptance checklist

- [x] A request using `priority` keeps its configured candidate order even if its advisory rank is lower.
- [x] Operators can see recommendation factors and current priority order locally, with no prompt or secret leakage.
- [x] An operator can manually stage a channel as first choice and consciously save it.
- [x] Default requests have no budget cap and preserve configured order.
- [x] Explicit strict and cheapest budget semantics are deterministic and covered by unit tests.
- [x] Existing desktop test, typecheck, lint, smoke, cache-resilience, and packaging checks pass.

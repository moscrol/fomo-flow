# Codex Config Takeover Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an enabled Codex hot route pointed at Dao after Codex/Cockpit rewrites its managed provider connection during startup.

**Architecture:** Add a fail-closed, one-shot known-value reconciler to the existing Codex hot-route module, then run it from one bounded timer owned by the Dao Origin lifecycle. Preserve the existing committed-request acknowledgement so the HUD reports `restart-required` until traffic actually crosses Dao.

**Tech Stack:** Node.js CommonJS, TOML line-preserving edits, atomic filesystem writes, Node assert tests, Dao Origin runtime.

---

### Task 1: Reconciliation core

**Files:**
- Modify: `vendor/外接api/core/codex_hot_route.js`
- Modify: `test/codex-hot-route.test.js`

- [ ] **Step 1: Write failing known-reset and drift tests**

Add fixture cases that overwrite the managed Base URL/token with the exact
saved upstream values, a known mixed state, and unknown values. Assert that
only exact known states are repaired and unrelated TOML remains byte-stable.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node test/codex-hot-route.test.js`  
Expected: FAIL because `reconcileCodexConfig` is not exported.

- [ ] **Step 3: Implement minimal one-shot reconciliation**

Add `reconcileCodexConfig(options)` using the existing parser,
`patchCodexConfig()`, handoff, and private atomic writers. On repair, save
`restartRequired: true`, clear the old acknowledgement, and expose only a
sanitized result enum and timestamps.

- [ ] **Step 4: Run the focused test**

Run: `node test/codex-hot-route.test.js`  
Expected: `codex hot route selftest: PASS`.

### Task 2: Guard lifecycle

**Files:**
- Modify: `vendor/外接api/core/codex_hot_route.js`
- Modify: `vendor/bundled-origin/source.js`
- Create: `test/codex-config-guard.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing timer lifecycle tests**

Inject a one-shot reconciler and verify immediate delayed run, non-overlap,
state-transition logging, single timer ownership, and stop behavior.

- [ ] **Step 2: Implement `startConfigGuard()` and `stopConfigGuard()`**

Use one unref'd interval and one short startup timer. Accept `getApiKey`, port,
paths, interval, and logger as dependencies. Never retain or log the key.

- [ ] **Step 3: Wire the guard to Origin start/close**

Start it after `_actualPort` is known and stop it from the returned handle's
`close()` and module `stop()` paths.

- [ ] **Step 4: Run focused lifecycle tests**

Run: `node test/codex-config-guard.test.js && node test/codex-hot-route.test.js`  
Expected: both PASS.

### Task 3: Routing truth regression

**Files:**
- Modify: `test/web-hud-projection.test.js`
- Modify only if needed: `core/web_hud_projection.js`

- [ ] **Step 1: Assert post-repair status semantics**

Verify managed plus `restartRequired` projects to `restart-required`, an
observed request projects to `routed`, and unmanaged config projects to
`bypassed`.

- [ ] **Step 2: Run HUD tests**

Run: `node test/web-hud-projection.test.js && node test/web-hud-client.test.js`  
Expected: both PASS.

### Task 4: Deploy and accept

**Files:**
- Sync: `vendor/外接api/core/codex_hot_route.js` to the installed Dao extension
- Sync: `vendor/bundled-origin/source.js` to the installed Dao extension

- [ ] **Step 1: Run regression suite**

Run focused Codex, HUD, cache resilience, and syntax tests before deployment.

- [ ] **Step 2: Deploy and reload Devin Window**

Copy only verified runtime files into the installed extension and reload the
extension host because JavaScript changed.

- [ ] **Step 3: Activate current takeover**

Apply the existing Codex hot route so the saved handoff records the current
Cockpit endpoint and Dao loopback key.

- [ ] **Step 4: Verify the real guard**

Confirm the config points to `http://127.0.0.1:8955/codex-hot/v1`, HUD reports
`restart-required` before a committed request, and a later request changes it
to `routed` with a fresh CODEX network sample.

- [ ] **Step 5: Preserve unrelated dirty work**

Use path-specific diffs and staging. Do not include existing TTFT, cache,
router, UI, or documentation work in this fix.

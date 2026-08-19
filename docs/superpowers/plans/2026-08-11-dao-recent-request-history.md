# Dao Flow 最近请求历史 Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with focused tests and checkpoints.

**Goal:** Preserve safe recent request history across runtime restarts, including zero-token failures, without changing cache-rate math.

**Architecture:** `dao_router` keeps a bounded, sanitized history file next to its config and restores it only into the request rail. `usage()` splits that request history from the current-process cache-eligible samples. The existing Web HUD projection and Electron renderer consume the existing `requests` array unchanged.

**Tech Stack:** Node.js CommonJS runtime, Node assert tests, React/Electron HUD.

---

### Task 1: Add the zero-token request regression

**Files:**
- Modify: `test/cache-resilience.test.js`

- [x] Record one provider sample with `{ input: 0, output: 0, cached: 0 }` and `{ success: false, errorCategory: 'upstream' }`.
- [x] Assert `router.usage()[provider].requests` contains that safe sample and its failure category.
- [x] Assert `recent.calls === 0` and `recent.hitRate === 0` for that provider.
- [x] Run `node test/cache-resilience.test.js` and confirm the request-history assertion fails before implementation.

### Task 2: Split history and cache sample filters

**Files:**
- Modify: `vendor/外接api/core/dao_router.js`

- [x] In `usage()`, derive `providerSamples` from every matching `_cacheSamples` row.
- [x] Derive `cacheSamples = providerSamples.filter(sample => sample.input > 0)` only for `recent` cache-window fields.
- [x] Return `requests: providerSamples.slice(-20)`.
- [x] Re-run the focused regression and Web HUD projection/client tests.

### Task 3: Verify the actual HUD

**Files:**
- Modify: `desktop/README.md`

- [x] Document that recent requests can show safe zero-token failed attempts while cache rates still require observed usage.
- [x] Reload the HUD and verify `最近请求` renders safe request rows from the selected `:8955` source without interrupting the active Devin session.
- [x] Add restart persistence regression and verify the history file excludes request content.
- [x] Run relevant root and desktop tests, typecheck, lint, and diff checks; package/install the desktop app after the renderer fallback changed. `prettier --check` still reports pre-existing formatting drift in dirty legacy files, so no broad formatter rewrite was applied.

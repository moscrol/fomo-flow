# cccc Cache Prefix Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain and improve cccc prompt-cache reuse without changing its route, protocol, model, priority, or the installed Devin plugin.

**Architecture:** Extend the existing prompt-cache policy to derive a real stable-prefix diagnostic for implicit OpenAI Chat while preserving the request body. Add a pure continuity classifier over bounded safe request facts, project its result into HUD data, and render recent plus cumulative cache truth together.

**Tech Stack:** Node.js CommonJS, React, TypeScript, Vitest, existing Dao HUD projection.

---

### Task 1: Fix implicit stable-prefix diagnostics

**Files:**
- Modify: `vendor/外接api/core/prompt_cache_policy.js`
- Modify: `test/prompt-cache-policy.test.js`

- [x] Add a failing test with stable system/user/tool history followed by `<!--dao-agent-status-->`; assert implicit diagnostics include the stable history, exclude the dynamic suffix, and do not mutate or reorder the body.
- [x] Run `node test/prompt-cache-policy.test.js` and require the current `stablePrefixChars === 2` behavior to fail.
- [x] Select the final non-volatile message as the implicit diagnostic boundary without adding an explicit breakpoint or changing message order.
- [x] Re-run the focused policy test and `node test/prompt-cache-router.test.js`.

### Task 2: Classify safe prefix continuity

**Files:**
- Create: `core/cache_prefix_continuity.js`
- Create: `test/cache-prefix-continuity.test.js`
- Modify: `core/web_hud_projection.js`
- Modify: `test/web-hud-projection.test.js`

- [x] Add failing worked examples for cold, append-only, rewritten, family-changed and unknown using only hashes, counts and sanitized stable item digests.
- [x] Implement a bounded pure classifier; never accept or return message text, prompt cache keys, paths or raw IDs.
- [x] Project `prefixState`, `prefixGeneration` and a fixed `prefixReason` on recent requests.
- [x] Run the two focused Node tests.

### Task 3: Render recent and cumulative cache truth

**Files:**
- Modify: `desktop/src/components/control/hud/hudProjection.ts`
- Modify: `desktop/src/components/control/hud/HudProviders.tsx`
- Modify: `desktop/src/components/control/hud/HudProviders.test.tsx`
- Modify: `desktop/src/components/control/hud/HudRequests.tsx`
- Modify: `desktop/src/components/control/hud/HudRequests.test.tsx`

- [x] Add failing UI tests requiring both `近期 HIT` and `累计 HIT`, plus the fixed Chinese explanations for append-only, rewritten and family-changed.
- [x] Extend the safe TypeScript projection and render the approved copy without exposing internal hashes as the primary explanation.
- [x] Run the focused Vitest suites.

### Task 4: Verify and package

**Files:**
- Modify: `docs/DAO_DESKTOP_PARITY.md`

- [x] Run prompt-cache, HUD projection and cache resilience Node suites.
- [x] Run Desktop typecheck, lint and all tests.
- [x] Build the arm64 app and install it with a timestamped backup; do not open Devin during verification.
- [x] Query the loopback safe HUD snapshot and confirm cccc protocol/provider/model/priority are unchanged and cached values remain upstream facts.

Installed verification on 2026-08-12: `/Applications/Dao Flow.app` is the arm64 `9.9.423` build, loopback is healthy on `:8955`, all 22 observed `cccc / claude-opus-5` routes remain `openai-chat + priority`, and the native request table no longer renders the legacy `{}` diagnostic as `2 ch`.

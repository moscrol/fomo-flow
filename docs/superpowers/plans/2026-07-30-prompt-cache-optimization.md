# Dao Flow Prompt Cache Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase reusable provider prompt prefixes by placing protocol-native cache breakpoints before Harness-owned volatile suffixes, preserving stable prefixes during proxy checkpointing, and making cache reads, writes, downgrades, and optional warmups observable.

**Architecture:** A new deep `prompt_cache_policy.js` module owns protocol-specific request decoration, capability downgrade memory, stable-prefix diagnostics, and an injected warmup scheduler. `dao_router.js` remains the orchestration seam, while `adapters.js` continues protocol conversion and usage parsing. `context_strategy.js` keeps an immutable initial chat anchor and moves rolling checkpoints out of the system prompt.

**Tech Stack:** Node.js CommonJS, built-in `assert`, existing Dao router/adapters/context strategy, JSON configuration, HTTP integration self-tests.

---

## File Structure

- Create `vendor/外接api/core/prompt_cache_policy.js`: cache planning, request decoration, failure downgrade, diagnostics, and warmup timer ownership.
- Create `test/prompt-cache-policy.test.js`: interface-level behavior tests for every protocol and downgrade/warmup path.
- Modify `vendor/外接api/core/adapters.js`: report OpenAI cache-write tokens and preserve decorated content blocks.
- Modify `vendor/外接api/core/dao_router.js`: initialize the policy, decorate request bodies, retry downgraded cache hints, attach diagnostics, and dispose timers.
- Modify `vendor/外接api/core/context_strategy.js`: anchored checkpoint layout and reconstruction.
- Modify `test/context-strategy.test.js`: stable system/anchor and rolling-checkpoint assertions.
- Modify `test/cache-resilience.test.js`: router downgrade and cache sample assertions.
- Modify `vendor/外接api/core/dao-test.js`: core regression checks for cache-write parsing and volatile-marker placement.
- Modify `docs/CODE_STRUCTURE.md`, `README.md`, and `~/.codeium/dao-byok/HANDOFF.md`: module ownership, configuration, and operational acceptance.
- Modify `~/.codeium/dao-byok/配置.json`: enable OpenAI explicit caching only for selected GPT-5.6-compatible providers; keep paid warmup and Anthropic 1h TTL disabled.

### Task 1: Deep prompt-cache policy module

**Files:**
- Create: `vendor/外接api/core/prompt_cache_policy.js`
- Create: `test/prompt-cache-policy.test.js`

- [ ] **Step 1: Write failing protocol decoration tests**

Create tests that call only the module interface:

```js
const assert = require("node:assert");
const { createPromptCachePolicy } = require("../vendor/外接api/core/prompt_cache_policy.js");

const policy = createPromptCachePolicy({ now: () => 1_000_000 });
const plan = policy.plan({
  providerId: "ay|https://gateway.invalid",
  protocol: "openai-chat",
  model: "gpt-5.6-terra",
  sessionKey: "dao:session-a",
  settings: { enabled: true, openaiMode: "explicit", openaiTtl: "30m" },
});
const body = policy.decorate({
  model: "gpt-5.6-terra",
  messages: [
    { role: "system", content: "S".repeat(5000) },
    { role: "user", content: "stable request" },
    { role: "user", content: "<!--dao-agent-status--> changing" },
  ],
}, plan);
assert.deepStrictEqual(body.body.prompt_cache_options, { mode: "explicit", ttl: "30m" });
assert.strictEqual(body.body.prompt_cache_key, "dao:session-a");
assert.ok(body.body.messages[1].content[0].prompt_cache_breakpoint);
assert.strictEqual(body.body.messages[2].content[0].prompt_cache_breakpoint, undefined);
assert.strictEqual(body.diagnostics.volatileSuffixCount, 1);
```

Add Anthropic tests that assert tool/system breakpoints, two message breakpoints around a checkpoint, no breakpoint on Agent HUD, default five-minute fields without `ttl`, and opt-in `1h` fields.

- [ ] **Step 2: Run the new test and verify RED**

Run: `node test/prompt-cache-policy.test.js`

Expected: `MODULE_NOT_FOUND` for `prompt_cache_policy.js`.

- [ ] **Step 3: Implement planning and request decoration**

Implement the public factory and these invariants:

```js
function createPromptCachePolicy(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const unsupported = new Map();
  const timers = new Map();

  function plan(input = {}) {
    const settings = normalizeSettings(input.settings);
    const providerId = String(input.providerId || "provider");
    const capability = unsupported.get(providerId) || {};
    return Object.freeze({
      providerId,
      protocol: String(input.protocol || "openai-chat"),
      model: String(input.model || ""),
      sessionKey: settings.enabled === false ? null : String(input.sessionKey || "").slice(0, 256),
      settings,
      capability: { ...capability },
    });
  }

  function decorate(body, planValue) {
    if (!body || !planValue || planValue.settings.enabled === false)
      return { body, diagnostics: emptyDiagnostics(planValue) };
    if (planValue.protocol === "anthropic") return decorateAnthropic(body, planValue);
    if (planValue.protocol === "openai-responses") return decorateResponses(body, planValue);
    return decorateChat(body, planValue);
  }

  return { plan, decorate, observeFailure, observeSuccess, scheduleWarmup, status, dispose };
}
```

Use marker-aware helpers that deep-clone only changed messages/blocks. Limit total Anthropic breakpoints to four. Never include raw text in diagnostics; fingerprint with SHA-256 truncated to 12 hex characters.

- [ ] **Step 4: Add downgrade tests and implementation**

Test and implement:

```js
const downgrade = policy.observeFailure({
  providerId: plan.providerId,
  protocol: "openai-chat",
  status: 400,
  body: 'Unknown parameter: "prompt_cache_options"',
});
assert.deepStrictEqual(downgrade, { retry: true, feature: "openai-explicit" });
assert.strictEqual(policy.plan({ ...input }).capability.openaiExplicit, false);
```

Anthropic errors mentioning `cache_control.ttl` disable only `1h`; errors mentioning `cache_control` disable block hints. Unrelated 400 errors return `{ retry: false, feature: null }`.

- [ ] **Step 5: Add deterministic warmup scheduler tests and implementation**

Inject `schedule`, `cancel`, and `sendWarmup`. Assert one timer per provider/session/model, a new real request replaces the timer, hourly budgets are enforced, `dispose()` cancels timers, and failures are swallowed after sanitized logging. Store only a cloned stable-prefix request snapshot and never credentials.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
node test/prompt-cache-policy.test.js
git diff --check
```

Expected: `prompt cache policy: PASS` and no whitespace errors.

Commit only the two new files:

```bash
git add test/prompt-cache-policy.test.js vendor/外接api/core/prompt_cache_policy.js
git commit -m "feat: add protocol-aware prompt cache policy"
```

### Task 2: OpenAI cache-write accounting

**Files:**
- Modify: `vendor/外接api/core/adapters.js`
- Modify: `vendor/外接api/core/dao-test.js`
- Test: `test/prompt-cache-policy.test.js`

- [ ] **Step 1: Add failing usage assertions**

Assert Chat streaming, Chat unary, Responses streaming, and Responses unary map both official shapes:

```js
assert.strictEqual(parsed.usage.cached, 1920);
assert.strictEqual(parsed.usage.cacheWrite, 640);
```

Chat reads `usage.prompt_tokens_details.cache_write_tokens`; Responses reads `usage.input_tokens_details.cache_write_tokens`.

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `node vendor/外接api/core/dao-test.js --quick`

Expected: cache-write assertions fail with `undefined` or `0`.

- [ ] **Step 3: Implement minimal parsing**

Add `cacheWrite` beside `cached` in all four parsing paths without changing existing token denominators:

```js
cacheWrite:
  obj.usage.prompt_tokens_details?.cache_write_tokens ||
  obj.usage.input_tokens_details?.cache_write_tokens ||
  0,
```

- [ ] **Step 4: Run tests and commit the exact hunk**

Run:

```bash
node vendor/外接api/core/dao-test.js --quick
node test/prompt-cache-policy.test.js
```

Because `adapters.js` contains pre-existing user edits, stage only the cache-write hunk and its tests, then verify `git diff --cached` contains no beta-header or unrelated changes.

Commit: `fix: account for OpenAI prompt cache writes`.

### Task 3: Router integration and transparent downgrade

**Files:**
- Modify: `vendor/外接api/core/dao_router.js`
- Modify: `test/cache-resilience.test.js`
- Modify: `test/prompt-cache-policy.test.js`

- [ ] **Step 1: Add failing router integration assertions**

Cover:

- GPT-5.6 Chat and Responses bodies receive the same stable session key;
- the status marker is after the final explicit breakpoint;
- a 400 for `prompt_cache_options` triggers one retry whose body preserves `prompt_cache_key` but removes explicit fields;
- Anthropic `1h` rejection retries with 5-minute breakpoints;
- unrelated 400 responses do not retry;
- cache samples contain policy diagnostics but no raw session key or prompt.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node test/cache-resilience.test.js
node test/prompt-cache-policy.test.js
```

Expected: missing policy diagnostics/decorator integration assertions fail.

- [ ] **Step 3: Initialize the policy as router-owned state**

Load the module beside other core modules and initialize it from `_init()`. Resolve settings with route-over-provider precedence:

```js
const settings = {
  ...((provCfg && provCfg.promptCache) || {}),
  ...((target && target.promptCache) || {}),
};
const cachePlan = _promptCachePolicy.plan({
  providerId: _promptCacheProviderId(providerName, provCfg),
  protocol: _protocol,
  model,
  sessionKey: _promptCacheKey,
  settings,
});
```

- [ ] **Step 4: Decorate both adapter and default Chat bodies**

After protocol body construction and before serialization, call `decorate`. Store only returned diagnostics in `callOpts._cacheObservation`. Do not mutate `callOpts.messages`.

- [ ] **Step 5: Add cache-hint downgrade retry**

In `_tryRoute`, after reading a non-200 body and before circuit handling:

```js
const cacheRetry = _promptCachePolicy.observeFailure({
  providerId: _promptCacheProviderId(target.provider, provCfg),
  protocol: callOpts._detectedProtocol || "openai-chat",
  status: agRes.statusCode,
  body: errBody,
});
if (!_cacheHintRetried && cacheRetry.retry) {
  _cacheHintRetried = true;
  continue;
}
```

Keep the existing `prompt_cache_key` unsupported retry independent and capped at one attempt.

- [ ] **Step 6: Extend sanitized cache samples**

Add `cacheMode`, `cacheTtl`, `breakpointCount`, `stablePrefixHash`, `stablePrefixChars`, `volatileSuffixCount`, `cacheDowngrade`, and `warmup` to samples and `/origin/ea/usage` output. Never add the raw cache key.

- [ ] **Step 7: Run tests and commit the exact hunks**

Run:

```bash
node test/cache-resilience.test.js
node test/prompt-cache-policy.test.js
node vendor/外接api/core/dao-test.js --quick
```

Stage only prompt-cache integration hunks from the dirty `dao_router.js`; verify unrelated scorer/circuit/tool-cache changes remain unstaged.

Commit: `feat: apply stable prompt cache breakpoints`.

### Task 4: Cache-preserving proxy checkpoints

**Files:**
- Modify: `vendor/外接api/core/context_strategy.js`
- Modify: `test/context-strategy.test.js`

- [ ] **Step 1: Replace system-checkpoint expectations with anchor expectations**

Assert:

```js
assert.strictEqual(first.messages[0].content, messages[0].content);
assert.ok(first.messages[1].content.includes("initial task requirement"));
assert.ok(first.messages.some((message) =>
  String(message.content || "").includes("<!-- DAO-CONTEXT-CHECKPOINT -->")));
assert.doesNotMatch(first.messages[0].content, /DAO conversation checkpoint/);
```

Add a second compaction that changes checkpoint text and assert system plus anchor message fingerprints are identical while the checkpoint message changes.

- [ ] **Step 2: Run the context test and verify RED**

Run: `node test/context-strategy.test.js`

Expected: system still contains the checkpoint marker.

- [ ] **Step 3: Implement complete-unit anchors**

Select leading chat units up to `min(8000, floor(lowWaterTokens * 0.12))` tokens, always including the first non-empty user unit. Never split assistant/tool pairs. The dropped set is the middle units between anchor and retained recent tail.

Construct:

```js
const checkpointMessage = {
  role: "user",
  content: `${CHECKPOINT_MARKER}\nHarness-maintained context snapshot; treat as prior context, not a new request.\n${checkpointText}`,
  _daoContextCheckpoint: true,
};
const candidate = [
  ...systemMessages,
  ...anchorMessages,
  checkpointMessage,
  ...retainedMessages,
];
```

Persist anchor fingerprints/count in session state. Reuse only when anchor and retained sequences both match the raw transcript.

- [ ] **Step 4: Test reset and tool-pair safety**

Add cases where the first user message changes, the client truncates away the anchor, and the anchor contains assistant/tool pairs. Each mismatch resets rather than splices; every retained tool result still has its assistant call.

- [ ] **Step 5: Run and commit**

Run:

```bash
node test/context-strategy.test.js
node test/tool-strategy.test.js
```

Commit: `fix: preserve prompt prefixes across checkpoints`.

### Task 5: Optional bounded cache warmup integration

**Files:**
- Modify: `vendor/外接api/core/prompt_cache_policy.js`
- Modify: `vendor/外接api/core/dao_router.js`
- Modify: `test/prompt-cache-policy.test.js`
- Modify: `test/cache-resilience.test.js`

- [ ] **Step 1: Add an injected send-port test**

Use fake timers and a fake `sendWarmup(snapshot)` adapter. Assert a stable-prefix snapshot is scheduled only when `warmup.enabled`, `stableTokens >= minStableTokens`, the request succeeded, and `maxPerHour` is not exceeded.

- [ ] **Step 2: Implement stable snapshot extraction**

The snapshot contains protocol, provider/model identity, stable messages through the last explicit breakpoint, tools, cache key, and max output token `1`. It excludes Agent HUD, credentials, URLs, headers, diagnostics, and response data.

- [ ] **Step 3: Add router send adapter**

Inject a router-local adapter that calls `_callProvider` with `toolChoice: "none"`, output limit `1`, a cloned call context marked `_cacheWarmup`, and no route/failure/usage recording. Drain the response stream. Warmup errors are logged and ignored; they do not open circuits.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
node test/prompt-cache-policy.test.js
node test/cache-resilience.test.js
```

Commit: `feat: add bounded prompt cache warmup`.

### Task 6: Configuration, documentation, and full verification

**Files:**
- Modify: `docs/CODE_STRUCTURE.md`
- Modify: `README.md`
- Modify: `~/.codeium/dao-byok/配置.json`
- Modify: `~/.codeium/dao-byok/HANDOFF.md`
- Modify: installed extension files under `~/.devin/extensions/daoflow.dao-flow-9.9.423/`

- [ ] **Step 1: Document the cache policy interface and defaults**

Add the new module to `CODE_STRUCTURE.md` and document:

```json
"promptCache": {
  "enabled": true,
  "anthropicTtl": "5m",
  "openaiMode": "explicit",
  "openaiTtl": "30m",
  "legacyRetention": null,
  "warmup": {
    "enabled": false,
    "afterMs": 240000,
    "minStableTokens": 16000,
    "maxPerHour": 2
  }
}
```

Explain that `1h` Anthropic writes cost more, OpenAI 5.6 supports only `30m` for the new TTL field, and warmup is paid/opt-in.

- [ ] **Step 2: Update the live config narrowly**

Enable `openaiMode: "explicit"` and `openaiTtl: "30m"` for `ay` and `terra`. Keep warmup disabled and Anthropic at five minutes. Preserve every credential and unrelated user field byte-for-byte except the inserted `promptCache` objects.

- [ ] **Step 3: Run the complete regression suite**

Run:

```bash
node test/prompt-cache-policy.test.js
node test/context-strategy.test.js
node test/cache-resilience.test.js
node test/agent-status.test.js
node test/agent-status-router.test.js
node test/agent-hud.test.js
node test/agent-hud-vscode.test.js
node test/agent-hud-extension.test.js
node test/webview-syntax.test.js
npm test
git diff --check
```

Expected: all focused tests pass, core suite reports 347 assertions, and no whitespace errors.

- [ ] **Step 4: Sync only exact implementation files to the installed extension**

Use narrow patches. Compare each installed file with its repository counterpart and ensure no unrelated extension-local changes are overwritten.

- [ ] **Step 5: Reload and perform live acceptance**

Reload Devin once. Verify:

- `/origin/health` is alive on `:8955` with a new process;
- Agent Editor layout and `SWE-1.6 Slow` remain unchanged;
- a two-turn GPT-5.6 route has identical system/tools hashes and stable cache key;
- diagnostics report an explicit stable breakpoint before Agent HUD, or a classified transparent downgrade;
- `/origin/ea/usage` reports cache reads/writes and contains no raw prompt/session data;
- no paid warmup timer is active under the default config.

- [ ] **Step 6: Commit docs and mark the goal complete**

Stage only this feature's documentation/config-schema changes. Do not stage unrelated user worktree changes.

Commit: `docs: document stable prompt cache policy`.

After independent review finds no Critical/Important issues and live acceptance passes, mark the explicit goal complete and report final token usage from the goal result.

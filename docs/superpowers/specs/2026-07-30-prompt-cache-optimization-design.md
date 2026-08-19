# Dao Flow Prompt Cache Optimization Design

## Goal

Increase provider-side prompt-cache reads and reduce useless cache writes without changing Devin's visible transcript, tool semantics, route failover, Agent HUD state, or the default `devin-native` context contract.

The design covers four controllable causes of misses:

1. volatile Harness metadata placed at a cache breakpoint;
2. proxy checkpoints rewriting the system prefix;
3. protocol-specific cache hints and TTLs being applied without capability gating;
4. insufficient read/write observability to distinguish cold starts, prefix churn, and provider eviction.

## Existing Baseline

Dao already provides:

- per-conversation `prompt_cache_key` for eligible OpenAI-compatible GPT routes;
- connection and provider affinity keyed by conversation;
- Anthropic breakpoints on the system prompt, final tool definition, and final message;
- Anthropic cache read/write extraction and OpenAI/DeepSeek cached-token extraction;
- cache hit-rate samples with prompt, tool, and message fingerprints;
- a context checkpoint state machine for proxy-managed custom routes;
- Agent HUD injection after context processing, at the end of the message list.

The baseline has two structural defects:

- the final Anthropic breakpoint lands on the changing `<agent_status>` message, so the write is not reusable on the next turn;
- `context_strategy` appends a rolling checkpoint to the system prompt, invalidating system and every later cache level whenever the checkpoint changes.

Default Devin routes currently use `devin-native`, so proxy checkpoint changes must remain scoped to routes that explicitly enable `contextStrategy`.

## Considered Approaches

### A. Skip only the Agent HUD message

Move the Anthropic final-message breakpoint to the preceding message. This is small and safe, but leaves OpenAI 5.6 explicit caching, checkpoint churn, TTL handling, downgrade behavior, and cache-write accounting fragmented.

### B. Protocol-aware cache policy module — selected

Add a deep `prompt_cache_policy` module at the request-body seam. It receives a freshly built provider request and a small policy input, then returns a decorated request plus sanitized diagnostics. The module owns volatile-marker detection, stable breakpoint selection, protocol-specific TTL fields, provider capability downgrades, and warmup eligibility.

This creates one test surface and keeps `dao_router.js` as orchestration.

### C. Force long TTLs and periodic provider calls everywhere

This can keep caches hot, but third-party gateways may reject current official fields and periodic model calls incur continuous cost. It is rejected as the default. Warmup remains an explicit, budgeted option.

## Architecture

### `prompt_cache_policy.js`

The module exposes a small interface:

```js
createPromptCachePolicy({ now, schedule, cancel, log })
  .plan(input)
  .decorate(body, plan)
  .observeFailure(input)
  .observeSuccess(input)
  .scheduleWarmup(input)
  .status()
  .dispose()
```

`plan(input)` resolves settings from route over provider over defaults. It never receives credentials. Its output contains only protocol, model family, cache key, selected strategy, TTL, and capability tier.

`decorate(body, plan)` mutates only the newly built request body and returns diagnostics:

- number and location class of breakpoints;
- stable-prefix fingerprint and approximate characters;
- volatile suffix count;
- requested and effective TTL/mode;
- any capability downgrade.

`observeFailure` recognizes cache-hint-specific 400/422 responses and downgrades only the rejected feature:

- OpenAI explicit breakpoint/options → implicit caching with `prompt_cache_key`;
- Anthropic `ttl: "1h"` → default 5-minute `ephemeral` breakpoints;
- block-level cache hints rejected → no block hints for that provider identity.

Downgrades are held in memory by provider identity (`provider + base URL`) and take effect on the transparent retry. Existing `prompt_cache_key` fallback remains authoritative for key-specific rejection.

### Volatile suffix classification

Messages containing these Harness-owned markers are volatile:

- `<!--dao-agent-status-->`;
- `<!-- DAO-CONTEXT-CHECKPOINT -->`.

The policy never caches an Agent HUD block. It may create two message breakpoints when a rolling checkpoint exists:

1. the last cacheable block before the checkpoint, preserving the immutable anchor;
2. the last cacheable block after the checkpoint but before Agent HUD, preserving incremental history while the checkpoint is unchanged.

Together with Anthropic's tool and system breakpoints, this stays within the four-breakpoint limit.

### Anthropic policy

Request order remains provider-native: `tools → system → messages`.

- Tool breakpoint: final tool definition.
- System breakpoint: final system content block.
- Message breakpoint(s): stable blocks selected around volatile Harness messages.
- Default TTL: omit `ttl`, retaining the provider-compatible five-minute `ephemeral` behavior.
- Optional TTL: `anthropicTtl: "1h"`; a rejected TTL transparently downgrades to five minutes.
- Existing user `anthropic-beta` tokens continue to be merged rather than overwritten.

### OpenAI policy

For GPT-5.6-family requests on providers configured with `openaiMode: "explicit"`:

- preserve the stable conversation `prompt_cache_key`;
- set `prompt_cache_options: { mode: "explicit", ttl: "30m" }`;
- add `prompt_cache_breakpoint: { mode: "explicit" }` to stable system/history content blocks;
- leave Agent HUD and other volatile suffixes after the final breakpoint.

Chat Completions string content is converted to a text-block array only when explicit caching is enabled. Responses input uses `input_text` blocks. If a compatible gateway rejects explicit fields, Dao retries in implicit mode with the stable key.

Earlier GPT models retain their existing implicit cache behavior. Long retention for older models remains opt-in through `legacyRetention`; it is not enabled globally.

## Checkpoint Placement

`context_strategy` will stop changing the system prompt. A checkpoint becomes one synthetic Harness context message after an immutable conversation anchor and before the retained recent tail:

```text
[system] [initial requirement anchor] [rolling checkpoint] [recent retained history] [Agent HUD]
```

The anchor contains complete chat units, including assistant/tool pairs, up to a bounded token budget. State stores anchor and retained fingerprints. Reuse is allowed only when both are found unchanged in the incoming raw transcript. A missing anchor resets proxy checkpoint state instead of splicing unrelated history.

This preserves semantic order: the checkpoint summarizes only the dropped middle history between anchor and recent tail. It also ensures checkpoint changes cannot invalidate tools, system, or the immutable initial requirement prefix.

## Warmup / Keepalive

Provider-cache warmup is configurable but disabled by default because it creates paid model requests.

```json
{
  "promptCache": {
    "warmup": {
      "enabled": false,
      "afterMs": 240000,
      "minStableTokens": 16000,
      "maxPerHour": 2
    }
  }
}
```

When enabled, the policy retains only an in-memory, credential-free request snapshot through the final stable breakpoint. One timer exists per provider/session/model. A newer real request replaces the timer. A warmup is eligible only after a successful cache-aware request, above the token threshold, below the hourly budget, and while the provider is not circuit-open. Warmup output is drained and discarded; it never enters the Devin transcript, Agent HUD, usage call count, or route affinity decisions. Shutdown cancels every timer.

The first release provides the scheduler and injected send port with deterministic tests. Live configuration remains disabled until real cache samples show TTL expiry rather than prefix churn is the dominant miss cause.

## Observability

Each cache sample gains sanitized fields:

- `cacheMode`, `cacheTtl`, `breakpointCount`;
- `stablePrefixHash`, `stablePrefixChars`, `volatileSuffixCount`;
- `cacheDowngrade`, `warmup`;
- `cacheWrite` for OpenAI's `cache_write_tokens` as well as Anthropic writes.

No raw prompts, message text, full paths, session IDs, or credentials are exposed. `/origin/ea/usage` remains the external observation interface.

## Configuration Defaults

```json
{
  "promptCache": {
    "enabled": true,
    "anthropicTtl": "5m",
    "openaiMode": "implicit",
    "openaiTtl": "30m",
    "legacyRetention": null,
    "warmup": {
      "enabled": false,
      "afterMs": 240000,
      "minStableTokens": 16000,
      "maxPerHour": 2
    }
  }
}
```

Route settings override provider settings. Existing `promptCacheKey: false|string|true` semantics remain compatible.

For the installed primary GPT-5.6-compatible channels, `openaiMode: "explicit"` will be enabled one provider at a time with transparent downgrade. Anthropic stays at five minutes unless a provider is explicitly opted into one hour.

## Error Handling

- Cache decoration failure returns the undecorated body and logs a sanitized reason; routing continues.
- Cache-hint 400/422 errors get one transparent downgraded retry.
- A downgraded provider is not re-probed until reload/config generation change.
- Warmup failure never opens a circuit and never changes the live route.
- Checkpoint reconstruction failure resets only that context-strategy session.

## Testing

1. Pure cache-policy tests for Anthropic, OpenAI Chat, and Responses request shapes.
2. Marker tests proving Agent HUD is always after the final stable breakpoint.
3. Checkpoint tests proving system and anchor fingerprints remain stable across rolling checkpoint updates.
4. Capability tests for explicit → implicit and 1h → 5m downgrade.
5. Warmup tests using injected timers and send adapter; no real provider calls.
6. Usage tests for read/write tokens and sanitized diagnostics.
7. Router integration tests for retry behavior and unchanged tool/Agent HUD semantics.
8. Full core, context, cache-resilience, adapter, webview syntax, and installed-extension tests.

## Deployment and Acceptance

- Sync only the cache-policy module and exact integration hunks into the installed extension.
- Preserve the user's unrelated dirty worktree changes, especially current `adapters.js` and `dao_router.js` edits.
- Reload Devin once JavaScript changes are installed.
- Verify health on `:8955`, unchanged layout/model selection, request shape diagnostics, and `/origin/ea/usage` fields.
- A real two-turn acceptance request must show identical system/tools hashes, a stable cache key, no breakpoint on Agent HUD, and either a positive cache read or a clearly classified provider cold/unsupported result.

## Non-goals

- Replacing Devin's native context compaction on default routes.
- Caching model outputs locally.
- Sharing cache keys across conversations or users.
- Enabling paid warmup or long TTL globally without provider-specific configuration.
- Changing route priority, model selection, tool availability, or Agent HUD activation rules.

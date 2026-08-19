# Codex Through Dao Observability Design

## Summary

Insert Dao between Codex and the existing Cockpit local-access sidecar, then
merge that network-level truth with Codex-native lifecycle telemetry in the
existing Dao Web HUD.

The target model path is:

```text
Codex
  -> http://127.0.0.1:8955/codex-hot/v1
  -> Dao Codex Hot Route
  -> cockpit-codex provider
  -> http://127.0.0.1:57244/v1
  -> Cockpit account pool
  -> OpenAI
```

The target status path is:

```text
Codex rollout events, with OTel as a later compatibility source
  -> Codex telemetry adapter
  -> normalized HUD session summary
  -> sanitized Web HUD projection
```

This preserves Cockpit's account pooling and upstream access while making
Codex requests, responses, cache effectiveness, failures, and Agent loop state
observable in the same browser HUD used for Devin.

## Goals

- Route Codex Responses API traffic through Dao without replacing Cockpit.
- Preserve the active Codex model, Responses protocol, reasoning setting,
  compact endpoint, tool calls, streaming behavior, and encrypted reasoning
  continuity.
- Attribute usage and prompt-cache metrics to individual Codex tasks.
- Show Codex tasks beside Devin tasks without cross-session contamination.
- Observe Codex task lifecycle, tool activity, compaction, and failures through
  Codex-native local telemetry.
- Preserve the Web HUD's current privacy posture: structured operational facts,
  never conversation content.
- Make the integration reversible without rewriting unrelated Codex settings.

## Non-goals

- Showing or storing user prompts, assistant response text, reasoning text,
  tool arguments, tool output, credentials, raw cache keys, raw thread ids, or
  full workspace paths.
- Replacing Cockpit account selection, quota management, or authentication.
- Automatically changing Codex to Grok, Terra, GLM, or another model when the
  Cockpit route fails.
- Making the Web HUD the source of truth for routing or task state.
- Exposing the HUD or telemetry collector beyond loopback.
- Controlling Codex's local tool execution through Dao.

## Current State

Codex currently uses the `codex_local_access` model provider with
`base_url = http://localhost:57244/v1`. Port 57244 is owned by Cockpit's
`cockpit-cliproxy`, so current Codex traffic does not cross Dao.

Dao already has:

- a stable `/codex-hot/v1/models` endpoint;
- Responses and Responses compact forwarding;
- protocol translation and streaming adapters;
- empty/reasoning-only response retry behavior;
- third-party usage accounting;
- a hot-route config and Codex config patcher;
- a sanitized multi-session Web HUD.

The missing seams are:

- a Cockpit-backed Dao provider;
- a reversible takeover of the active Codex provider's Base URL;
- Codex-specific observation metadata on reverse-proxy usage records;
- a private task-to-request correlation key;
- a Codex lifecycle telemetry source;
- a projection that accepts `surface: codex` instead of hard-coding Devin;
- source-aware Web HUD rendering.

## Chosen Architecture

Use the hybrid approach:

1. **Network path:** Codex sends all model traffic through Dao, which forwards
   it to Cockpit. This is authoritative for provider, model, request timing,
   HTTP/SSE outcomes, usage, cache reads, retries, and model-emitted tool calls.
2. **Lifecycle path:** a read-only Codex telemetry adapter consumes local
   rollout events. This is authoritative for task and turn lifecycle, actual
   local tool execution, approval waits, compaction, and task completion.
3. **Projection join:** private identifiers correlate the two streams. Only
   sanitized hashes and aggregates cross the HTTP boundary.

Neither source impersonates the other. When only one source is available, the
HUD displays partial truth and names the unavailable source.

## Component Design

### 1. Cockpit-backed provider

Register a dedicated Dao provider named `cockpit-codex`:

- base URL: `http://127.0.0.1:57244/v1`;
- protocol: `openai-responses`;
- model: `gpt-5.6-sol`;
- streaming enabled;
- authentication copied from the active Cockpit local-access provider into
  Dao's private configuration, never exposed through HUD APIs;
- no automatic fallback in the first release.

The Codex Hot Route points to this provider and keeps the request model visible
to Codex as `gpt-5.6-sol`.

### 2. Reversible Codex Base URL management

The integration changes only the active provider section in
`~/.codex/config.toml`:

- `base_url` becomes `http://127.0.0.1:8955/codex-hot/v1`;
- the provider bearer token becomes Dao's loopback reverse-proxy key;
- `model`, `model_provider`, `wire_api`, reasoning, auth mode, history, MCP,
  and unrelated settings remain unchanged.

Before mutation, persist a managed handoff record containing:

- active provider name;
- original Base URL;
- original bearer-token value in a private mode-0600 state file;
- a fingerprint of the exact fields Dao intends to manage;
- activation timestamp and Dao endpoint.

Disable/restore modifies only those managed fields. Restore fails closed if the
current values no longer match the values installed by Dao, preventing Dao from
overwriting a later user or Cockpit change.

Codex restart is required after Base URL activation or restoration. The HUD and
control endpoint must report `restart-required` until a real Codex request is
observed through the expected endpoint.

### 3. Codex request observation

For every `/codex-hot/v1/responses` and `/codex-hot/v1/responses/compact`
request, construct an internal observation context:

```text
source              codex
surface             codex
request id          generated internal id
cache fingerprint   hash(prompt_cache_key), when supplied
provider            cockpit-codex
requested model     model received from Codex
upstream model      model selected by the hot route
reasoning effort    normalized request setting
started at          monotonic/request timestamp
```

The context follows retries and response adaptation. Only the committed
attempt contributes normal usage. Failed attempts contribute attempt telemetry
but never duplicate successful token totals.

Record:

- input, output, cached-input, cache-write, and reasoning tokens when supplied;
- time to first visible model event;
- end-to-end duration;
- HTTP status and normalized error category;
- retry and channel-attempt count;
- finish reason;
- emitted tool-call count;
- visible output byte count, not output content;
- cache mode, TTL, breakpoint count, and stable-prefix facts already supported
  by the router when available.

Streaming and non-streaming responses use one normalized observation contract.

### 4. Codex lifecycle telemetry adapter

Add a read-only source that incrementally reads current Codex rollout JSONL
files under `~/.codex/sessions/YYYY/MM/DD/`.

The adapter:

- scans only current/recent date directories and active files;
- tails from saved byte offsets rather than rereading entire files;
- handles partial final lines, truncation, rotation, and process restart;
- bounds memory and retained completed sessions;
- recognizes the installed Codex event schema and counts unknown events;
- never copies message content or tool payloads into its state;
- exposes source health and schema-drift warnings.

Normalized task state includes:

- hashed thread/session identity;
- workspace basename;
- model and reasoning effort;
- active turn and task lifecycle;
- phase: starting, reasoning, using-tool, waiting-approval, compacting,
  completing, completed, failed, or stale;
- latest tool name and success flag, without arguments or output;
- compaction count;
- verification/failure facts when explicitly available;
- cumulative and last-turn token usage;
- last activity time.

OpenTelemetry is a later compatibility source, not a blocker for the first
release. When added, it feeds the same normalized store and is deduplicated by
thread, turn, event type, timestamp, and cumulative usage counters.

### 5. Metric ownership and private correlation

The two observation paths describe some of the same model usage, so the HUD
must assign one owner to each displayed fact instead of summing both streams.

- Dao network observations own provider/channel totals, recent requests,
  retries, HTTP/SSE outcomes, TTFT, end-to-end duration, and route health.
- Codex rollout telemetry owns per-task and per-turn token/cache totals,
  lifecycle state, tool execution, compaction, and completion.
- Global model-usage totals count routed network usage once. Codex rollout
  totals never get added to the same global number.
- If Codex is observed in rollout telemetry but is not traversing Dao, its task
  remains visible with `model-path: bypassed`; its token totals stay in the
  task detail and do not enter Dao's routed global total.

The internal store keeps separate private fingerprints for:

- Codex thread/session identity from rollout metadata;
- `prompt_cache_key` from Responses requests, when supplied.

The sources are joined only when an explicit identifier or a verified stable
mapping exists. Time-window, provider, model, token-count, or ordering guesses
must not attribute a network request to a task. Without an exact mapping, the
HUD truthfully shows task cache metrics from rollout telemetry and route-level
request metrics from Dao as separate facts.

The public snapshot receives a separate SHA-256-derived 12-character session
id. Internal fingerprints, raw thread ids, prompt-cache keys, and file paths
never appear in serialized HUD output.

### 6. Web HUD projection

Keep the current projection and add inputs rather than creating a second HUD.

The service gains readers for:

- normalized Codex session summaries;
- Codex source health;
- source-aware request samples.

The projection:

- accepts only whitelisted surfaces: `devin` and `codex`;
- merges both into the existing session list;
- retains active sessions and recently ended sessions for the existing
  15-minute window;
- uses Codex rollout totals for Codex per-session cache and the existing
  private-fingerprint join for Devin per-session cache;
- preserves provider/global aggregates;
- exposes source health as sanitized runtime warnings;
- never returns raw event payloads.

Global totals use routed network usage as the canonical token source. Lifecycle
telemetry may fill session detail but never double counts the same request. The
UI provides per-surface task views without implying that task-level telemetry
was added to provider totals.

### 7. Web HUD client

Reuse the current layout and visual language.

Add:

- `CODEX` badges beside existing `DEVIN` badges;
- source filters: All, Devin, Codex;
- a Source column in recent requests;
- Codex task facts for last-turn cache rate, cumulative cache rate, reasoning
  tokens, TTFT, duration, and compaction count;
- data-source badges for Model Path and Loop Telemetry;
- explicit `PARTIAL`, `STALE`, and `SCHEMA DRIFT` states.

Continue rendering all untrusted values with `textContent`. Do not add a prompt
or response viewer.

## State and Retention

- Active tasks remain visible while a turn is running or recent activity is
  within the existing active TTL.
- Completed tasks remain visible as recent for 15 minutes.
- Request samples remain bounded by the existing HUD limit.
- Tail checkpoints persist privately so Dao restart does not double count.
- Unknown or malformed events increment diagnostics and are discarded.
- Missing telemetry produces `unavailable`, never a fabricated zero.

## Failure Handling

### Dao unavailable

Codex cannot reach its configured Base URL. Recovery is an explicit restore to
the saved Cockpit endpoint; there is no silent config rewrite during an active
task.

### Cockpit unavailable

Dao returns a sanitized upstream-unavailable error and marks the model path
degraded. It does not silently route the request to a different model.

### HUD unavailable

Routing continues. HUD readers, projection, SSE clients, and telemetry parsing
must be isolated so failures cannot interrupt model traffic.

### Telemetry unavailable

Network metrics continue to update. Codex task state shows partial/unavailable
instead of inheriting a Devin state or claiming completion.

### Usage missing from upstream

Timing and status remain observable. Cache and token fields show unobserved,
not zero.

### Config drift

Activation and restoration compare managed fingerprints. A mismatch stops the
operation and reports the conflicting fields without exposing secret values.

## Security and Privacy

- All model, HUD, control, and future OTLP endpoints bind to loopback by
  default.
- Existing reverse-proxy bearer authentication remains required.
- Cockpit credentials live only in private config/state and are redacted from
  logs, APIs, errors, traces, and tests.
- Rollout parsing is allowlist-based; message and payload content is ignored.
- The browser receives sanitized summaries only.
- Existing CSP, no-store, no-referrer, nosniff, and loopback guards remain.
- Tests scan snapshots and logs for raw thread ids, cache keys, credentials,
  prompts, assistant content, tool payloads, and full paths.

## Testing Strategy

### Unit tests

- Reversible config activation and restore, including drift refusal.
- Cockpit provider normalization without credential exposure.
- Codex observation context and `source: codex` propagation.
- Streaming and unary token/usage normalization.
- Retry accounting counts committed usage once.
- Rollout tailing: partial lines, offsets, rotation, truncation, restart, and
  unknown schemas.
- Exact per-session cache attribution and refusal to use heuristic joins.
- Surface whitelist, retention, privacy, malformed data, and bounded arrays.

### Integration tests

- Fake Codex -> Dao -> fake Cockpit Responses streaming.
- Responses compact preserves encrypted continuity and strips unsupported
  fields only where existing behavior requires it.
- Tool-call streaming survives the two-hop path.
- Two concurrent Codex sessions receive distinct cache metrics.
- Devin and Codex sessions coexist without cross-attribution.
- SSE HUD updates and polling fallback remain functional.
- Dao model-path failure and telemetry failure remain isolated.

### Regression tests

- Existing Codex Hot Route tests.
- Web HUD projection, service, HTTP, and client tests.
- Prompt-cache policy, affinity, and resilience tests.
- Router, reverse-proxy, Agent Status, and full repository tests.

### Real-machine acceptance

1. Confirm Codex points to `http://127.0.0.1:8955/codex-hot/v1`.
2. Confirm Dao's `cockpit-codex` target points to port 57244.
3. Restart Codex and complete a normal streaming turn.
4. Complete a tool-using turn and a compacted turn.
5. Confirm recent requests show `source=codex` and provider
   `cockpit-codex`.
6. Run two Codex tasks and confirm separate task state and cache rates.
7. Confirm existing Devin sessions remain correct.
8. Stop Cockpit and confirm a clear degraded state without fallback-model
   substitution.
9. Restore direct Cockpit access and confirm only managed config fields change.
10. Inspect the HUD snapshot for prohibited data.

## Rollout Order

1. Reversible Cockpit provider and Codex Base URL handoff.
2. Codex request observation and source-aware usage.
3. Codex lifecycle telemetry adapter and private correlation.
4. Multi-surface projection and HUD rendering.
5. Focused regression suite and real-machine acceptance.
6. Optional OTel receiver after the rollout path is stable.

## Success Criteria

- A Codex request visibly traverses Dao before Cockpit.
- Codex retains native Responses behavior and model identity.
- The HUD shows authoritative Codex route, token, cache, latency, failure, and
  task-state facts.
- Two concurrent Codex tasks never share per-session cache or status.
- Devin behavior and metrics remain unchanged.
- Disabling the integration safely restores the prior Cockpit endpoint.
- No prohibited content crosses the HUD HTTP boundary.

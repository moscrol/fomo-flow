# Dao TTFT Optimization Design

## Goal

Reduce real time-to-first-visible-token (TTFT) across Dao-routed Devin and
Codex requests while keeping cache affinity, correctness, cost, and tool-call
safety ahead of raw speed. Make the latency source visible enough that the HUD
can distinguish a cache/prefill problem from an upstream/provider problem.

## Scope

This iteration delivers a conservative measurement-and-routing feedback loop:

- split end-to-end TTFT into Dao dispatch overhead, upstream header wait,
  upstream semantic-token wait, and retry overhead;
- retain bounded, content-blind latency samples by provider/model/source and by
  cache-hit bucket;
- expose rolling p50/p95 TTFT and duration in the Web HUD;
- feed truthful first-visible latency into the existing channel scorer;
- use p95-aware latency scoring only after enough successful samples exist.

This iteration does not enable parallel hedged requests, automatic reasoning
effort reduction, artificial first-token frames, cross-session prompt content
storage, or persistent raw request traces.

## Existing State

Dao already records end-to-end `ttftMs` and `durationMs` for reverse-proxy
requests. The Web HUD renders the latest task TTFT and recent request samples.
`channel_scorer.js` already has a latency factor, but its caller passes
`callOpts._ttfbMs`, which is never populated, so latency normally remains at the
neutral score. The scorer also uses a rolling average, which hides tail latency
and lets a few very slow requests look healthier than they feel to users.

The current SSE keepalive is not a TTFT optimization. Heartbeats may prevent a
client timeout but must never be counted as a semantic first token.

## Approaches Considered

### A. Observe only

Add p50/p95 and segmented timing to the HUD without changing routing. This is
the lowest-risk option, but known slow providers remain first in the route
order and the system does not improve automatically.

### B. Conservative feedback loop — selected

Add truthful segmented timing, bounded percentiles, and a p95-aware latency
factor in the existing scorer. Require a minimum sample count, preserve sticky
cache affinity, cap the latency factor's influence, and keep circuit/health
rules dominant. This improves the worst-case wait without changing prompts or
reasoning quality.

### C. Aggressive latency mode

Launch a backup request when the primary has not produced content by a
deadline, and automatically lower reasoning effort for short tasks. This can
reduce TTFT further, but it can double spend, duplicate tool calls, and change
answer quality. It remains a later opt-in feature after the conservative loop
has enough production evidence.

## Timing Model

Every request uses one monotonic wall-clock basis within its process. Public
samples contain durations only, never raw high-resolution timestamps.

The recorded fields are:

- `ttftMs`: request accepted by Dao to first visible text or tool call;
- `daoDispatchMs`: request accepted to the start of the first upstream attempt;
- `upstreamHeaderMs`: committed attempt start to upstream response headers;
- `upstreamSemanticMs`: committed attempt start to first visible text/tool;
- `retryOverheadMs`: total TTFT not attributable to first dispatch or the
  committed attempt's semantic wait, clamped to zero;
- `durationMs`: request accepted to terminal success/failure;
- `attemptCount`: number of upstream attempts;
- `firstSignalKind`: allowlisted `text`, `tool`, or `none`.

Reasoning-only deltas and keepalive frames do not satisfy first-visible. A tool
call start does satisfy it because the agent can begin useful work. Unary
responses use the moment the parsed visible output becomes available.

For failed requests, Dao records duration and retry overhead but leaves
semantic TTFT unavailable. Zero is not treated as an observed fast TTFT.

## Components

### Reverse-proxy observation

`vendor/外接api/core/revproxy.js` owns timing for OpenAI-compatible external and
Codex Hot Route requests. It creates one request observation before body
processing completes, creates attempt-local clocks inside `_bridge`, and emits
one terminal observation for the committed success or final failure.

Only the committed attempt supplies `upstreamHeaderMs`,
`upstreamSemanticMs`, and `firstSignalKind`. Discarded empty/retry attempts
contribute only to `attemptCount` and `retryOverheadMs`.

### Devin router observation

`vendor/外接api/core/dao_router.js` sets an attempt start before
`_callProvider`, records header wait when `_callProvider` resolves, and marks
the first visible text/tool inside the stream/unary adapters. It populates
`callOpts._ttfbMs` and `_totalMs` before calling `channel_scorer.recordSuccess`.

The existing cache observation receives the same sanitized timing fields so
Devin and Codex samples share one public schema.

### Latency statistics

`core/ttft_metrics.js` is a pure, content-blind module. It accepts sanitized
request samples and returns deterministic aggregates:

- count, p50, p95, minimum, maximum;
- cache bucket: `hit`, `miss`, or `unknown`;
- provider/model/source grouping;
- TTFT and total-duration distributions.

Percentiles use nearest-rank over sorted nonnegative observed values. A TTFT is
observed only when `success=true`, `firstSignalKind` is not `none`, and the
value is finite. Aggregation is bounded to the most recent 50 samples globally
and 20 public samples per provider, matching existing router limits.

### Channel scoring

`vendor/外接api/core/channel_scorer.js` retains at most 20 successful latency
samples per provider/model. Its public metric snapshot adds `p50TtftMs`,
`p95TtftMs`, and `sampleCount`.

Latency scoring follows these rules:

- fewer than 3 observed samples: neutral `0.5`;
- 3 or more samples: score primarily from p95, with p50 as a stability guard;
- 500 ms or faster p95 approaches `1.0`;
- 5 s p95 is approximately `0.2`;
- 10 s or slower never falls below `0.05` solely because of latency;
- health/circuit rules remain dominant and sticky cache affinity remains ahead
  of scored non-sticky candidates.

This avoids overreacting to one lucky or unlucky request and prevents a new
channel from being starved before it has evidence.

### Web HUD

`core/web_hud_projection.js` adds a sanitized `latency` object to each provider
and global runtime summary. It includes overall and cache hit/miss p50/p95 plus
sample counts. Recent requests expose the timing breakdown fields and
`firstSignalKind`.

The UI adds compact provider TTFT p50/p95 metrics, a cache hit/miss comparison,
and timing breakdown columns in the recent-request table. Missing values
render as `—`; zero is shown only when it was actually observed.

No prompt, response text, tool arguments/output, raw cache key, raw task id, or
full path is introduced.

## Data Flow

1. Dao accepts a request and records a request-start clock.
2. Each upstream attempt records start and header arrival.
3. The protocol adapter identifies the first visible text or tool call.
4. Terminal success/failure writes one sanitized bounded request sample.
5. Successful first-visible latency updates the in-memory channel scorer.
6. HUD projection computes deterministic p50/p95 aggregates from bounded
   samples and separates cache hit, miss, and unknown buckets.
7. A later request ranks non-sticky candidates using health, p95-aware latency,
   cost, cache affinity, stability, quota, task fit, and declared priority.

## Error Handling

- Timing failures never fail or delay model routing.
- Missing clocks produce unavailable fields, not fabricated zero latency.
- Failed/empty attempts never enter successful percentile distributions.
- A terminal failed request remains visible with `errorCategory`, duration, and
  attempt count.
- Scorer exceptions preserve the configured candidate order.
- Unknown cache usage goes to the `unknown` bucket instead of being called a
  miss.
- Process restarts reset scorer history; HUD request samples already follow the
  router's existing in-memory lifecycle.

## Configuration

The first release uses safe fixed defaults: 20 scorer samples, minimum 3
samples for latency ranking, and the existing latency weight of 0.15. These
values are exposed in status but are not added as user-facing controls until
production data shows a need. Hedging and automatic reasoning changes remain
disabled.

## Testing

Tests cover:

- first text and first tool timing without counting reasoning/heartbeat;
- retry accounting and committed-attempt timing;
- terminal failures with unavailable TTFT;
- nearest-rank p50/p95 and cache hit/miss/unknown grouping;
- fewer-than-three-samples neutrality;
- p95 causing a consistently fast provider to rank ahead of a tail-slow one;
- sticky cache affinity remaining first;
- HUD privacy, missing-value rendering, source filtering, and deterministic
  projection;
- existing Codex Hot Route, cache-resilience, and full Dao suites.

## Acceptance Criteria

- HUD shows provider p50/p95 TTFT and separates cache hit from miss.
- Recent requests show truthful dispatch/header/semantic/retry timing.
- Heartbeats and hidden reasoning do not lower visible TTFT.
- A real multi-channel route with at least three samples prefers materially
  lower p95 when health and cache affinity are otherwise equal.
- Sticky affinity, circuit breakers, and fixed fallback safety still win where
  designed.
- No new content or identifiers cross the sanitized HUD boundary.
- All focused tests, `cache-resilience.test.js`, and `npm test` pass.

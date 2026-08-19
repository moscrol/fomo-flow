# Dao Request / Attempt Observability Design

## Summary

Add a bounded request-to-attempt observation contract to Dao's routed network
path. One IDE model request receives one private `requestId`; every upstream
network call for that request receives an ordered `attemptId`.

The existing usage ring continues to store one committed request summary, so
usage, token, cache, and cost totals remain single-counted. The summary carries
a bounded, sanitized attempt list for failure attribution and retry diagnosis.

## Goals

- Correlate each routed request with its upstream attempts.
- Explain which provider/model attempt failed, why it failed, and which attempt
  produced the committed response.
- Preserve one request-level usage record per committed request.
- Project sanitized attempt facts into `/origin/ea/usage` and Web HUD recent
  requests without exposing prompts, cache keys, raw session IDs, credentials,
  workspace paths, tool arguments, or response content.
- Preserve existing consumers that only use `attemptCount` and latency fields.

## Non-goals

- Cost or cache-savings accounting.
- A global unbounded attempt table.
- A new large HUD page or attempt-detail UI.
- Automatic task creation for normal Devin/Codex conversations.
- Full server-side tool retry tracing; this increment first covers upstream
  provider attempts, including HTTP failures and empty-stream retries.

## Contract

### Request summary

The router creates one opaque `requestId` at the start of a routed request.
It is retained only in process memory and sanitized before any public
projection. A request summary contains:

```text
requestId          opaque request identifier, internal only
attemptCount       number of recorded upstream attempts
committedAttemptId internal identifier of the attempt that produced the response
attempts           bounded list, newest contract fields only
```

The public HUD request keeps an opaque derived display ID. It does not expose
`requestId` or `attemptId`.

### Attempt record

Each call to an upstream provider creates a record:

```text
attemptId          requestId + sequential attempt index, internal only
attemptIndex       1-based integer
provider           configured provider name
model              selected upstream model
startedAt          epoch milliseconds
endedAt            epoch milliseconds when known
durationMs         non-negative elapsed duration when known
status             HTTP status, 0 for transport failure, null while pending
outcome            committed | failed | discarded
errorCategory      bounded normalized category, empty on committed success
retryReason        bounded normalized retry trigger, empty on first attempt
usageObserved      true only when this attempt reported upstream usage
input/output/cached/cacheWrite
                   attempt usage values when reported; not added to totals
```

At most eight attempts are retained per request. The bound is sufficient for
normal fallback/retry diagnosis and prevents memory or public payload growth.

## Ownership and accounting

- The router owns request and attempt creation, provider/model attribution,
  HTTP/transport outcomes, retry reasons, and timing.
- The existing request summary owns committed usage totals. Only the committed
  response calls `_recordUsage`, so failed/discarded attempt usage never
  increases provider usage, token totals, cache totals, or future costs.
- An attempt may retain reported usage for diagnostic visibility, but it is
  labelled non-committed and is not aggregated into routed totals.
- Existing `attemptCount`, TTFT, retry-overhead, and duration fields remain
  populated for old HUD clients.

## Data flow

```text
route()
  -> create request context
  -> _beginProviderAttempt(provider, model, retry reason)
  -> provider response / transport error / empty stream
  -> finish attempt as committed, failed, or discarded
  -> _recordUsage(committed request summary + bounded attempts)
  -> usage request ring
  -> Web HUD recentRequests projection
```

For an HTTP failure followed by fallback success, the request has two attempt
records: the first is `failed`; the second is `committed`. The request summary
has `attemptCount: 2` and only the second response's usage is aggregated.

For an empty/reasoning-only stream followed by retry success, the first attempt
is `discarded`, the second is `committed`, and no discarded reasoning or usage
is exposed as committed output.

## Privacy and compatibility

- Raw request and attempt IDs remain internal; public projections derive their
  own display ID from safe operational fields.
- String fields are bounded and normalized before retention.
- The existing safe hash validation remains the only accepted correlation-key
  representation in usage samples.
- Older samples without `attempts` continue to project normally with their
  existing `attemptCount` defaulting to one.

## Testing and acceptance

Use a local mock provider to make the first upstream call fail and the second
succeed. Assert:

1. One committed usage summary is recorded.
2. The summary has two ordered attempts with distinct internal IDs.
3. First attempt has the failure status/category and is not committed.
4. Second attempt is committed and supplies the aggregated usage.
5. HUD recent request shows the existing aggregate attempt count and no raw
   request/attempt IDs, prompt text, cache key, or credentials.
6. Existing cache, HUD, Codex hot route, and TTFT regression tests pass.

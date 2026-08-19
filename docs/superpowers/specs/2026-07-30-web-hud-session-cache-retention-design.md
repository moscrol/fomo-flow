# Web HUD Session Cache and Retention Design

Date: 2026-07-30
Status: Approved
Selected approach: active sessions plus a 15-minute recently-ended window

## Goal

Make the selected-session cache metrics in Dao Web HUD truthful and keep the
session list useful during concurrent work. Cache effectiveness must be
calculated from requests belonging to the selected session, not copied from a
provider-wide aggregate. Sessions that stop producing activity remain visible
briefly for inspection, then disappear from the main list automatically.

## Current problem

The router already records a one-way `cacheKeyHash` on each bounded cache
sample. Agent Status owns the corresponding raw conversation key. The Web HUD
currently drops that correlation and resolves selected-session cache metrics by
provider name. Consequently, every session routed through the same provider
shows the provider's shared recent hit rate.

Agent summaries also remain in the projected list after activity stops. Dao
does not receive a reliable Devin UI event when a conversation tab is closed,
so visibility must be based on trusted request/update timestamps rather than a
claimed hard-close state.

## Selected behavior

### Session visibility

- A session is `active` under the existing activity rules and is always shown.
- A non-active session whose latest trusted activity is no more than 15 minutes
  old is shown as `recently-ended`.
- A non-active session older than 15 minutes is omitted from the main session
  list.
- Warning or verification-failure state does not bypass the retention limit;
  old failures must not permanently fill the operational view.
- The browser clears an invalid stored selection and selects the best remaining
  session using the existing active-first ordering.

The 15-minute window is a projection concern. It does not delete Agent Status
state files and does not prevent a resumed conversation from returning to the
list on its next update.

### Session cache metrics

Each projected session receives a bounded cache summary derived only from
router request samples whose `cacheKeyHash` matches that session's one-way
cache fingerprint:

```js
cache: {
  observed: true,
  calls: 2,
  input: 163481,
  cached: 102720,
  cacheWrite: 0,
  hitRate: 62.8,
  latestAt: 1785424925506
}
```

When no retained sample matches, the session exposes the same shape with
`observed: false` and zero counters. The UI renders an em dash and “暂无会话缓存样本”; it never falls back to provider-wide cache data.

Provider cards and top-level KPIs remain provider/global aggregates. Their copy
must identify them as channel-level statistics so users do not confuse them
with the selected-session metrics.

## Data flow and privacy

1. Agent Status supplies an internal conversation key to the pure projection.
2. The projection computes the same deterministic FNV-1a fingerprint already
   used by the router for `cacheKeyHash`.
3. The projection groups bounded router samples by provider and fingerprint.
4. Each session is joined only to the matching fingerprint and, when available,
   its actual route provider.
5. The fingerprint is used only during projection and is not included in the
   HTTP snapshot.

No raw conversation key, Cascade id, prompt-cache key, cache-key hash, prompt,
tool payload, credential, or full workspace path may cross the Web HUD HTTP
boundary. Hash collisions are unlikely but possible with the router's existing
32-bit fingerprint. Provider matching reduces accidental joins; replacing that
fingerprint is outside this change's scope because it would also alter cache
affinity and existing telemetry compatibility.

## Module changes

### `core/web_hud_projection.js`

- Add the router-compatible private fingerprint helper.
- Derive `latestActivityAt` as the maximum valid value of `lastRequestAt`,
  `lastUpdateAt`, and `updatedAt`. Never use `observedAt`: it records when the
  state was read and would keep an idle session visible forever.
- Filter non-active sessions after the 15-minute retention window.
- Aggregate request samples by provider and cache fingerprint.
- Attach the sanitized `cache` summary and `lifecycle` value to each session.
- Keep deterministic ordering, bounds, deep freezing, and sanitization.

### `ui/web-hud.js`

- Render selected-session cache metrics from `session.cache` only.
- Show `RECENT` for `recently-ended` sessions.
- Label provider cache figures as channel statistics.
- Preserve current selection behavior when the selected session ages out.

No router persistence format, Origin route, or Web HUD service lifecycle change
is required.

## Error handling

- Missing or malformed request samples produce `observed: false` rather than a
  fabricated rate.
- Samples without a valid fingerprint are retained in the global recent-request
  table but cannot be attributed to a session.
- A provisional or missing route provider permits a fingerprint-only match;
  a known route provider requires both provider and fingerprint to match.
- Invalid timestamps make an inactive session ineligible for the recent window.
- Projection errors continue to be isolated by the Web HUD service and cannot
  interrupt model routing.

## Testing

Projection regression tests must prove:

- Two sessions on one provider can report different hit rates.
- Samples from another session or provider are not mixed in.
- No matching sample yields `observed: false` and no provider fallback.
- Active sessions remain visible regardless of age.
- Non-active sessions remain visible through 15 minutes and disappear after the
  boundary.
- A resumed session reappears.
- Raw session keys and cache fingerprints remain absent from serialized output.
- Existing OpenAI and Anthropic hit-rate semantics remain unchanged.

Client tests must prove that the detail view uses `session.cache`, renders the
no-sample state, and does not look up provider cache metrics for the selected
session.

The focused Web HUD suites and the existing prompt-cache/router regression
suites must pass. After deployment, the live snapshot must show distinct cache
rates for two real Devin sessions routed through GLM and hide an inactive
session after the retention boundary.

## Acceptance criteria

- Switching sessions changes cache metrics when their retained samples differ.
- A session without attributable samples never displays a provider aggregate as
  its own result.
- Recently ended work remains inspectable for 15 minutes, then leaves the main
  list without deleting its underlying state.
- Provider/global cache observability remains available.
- No new sensitive identifier is exposed by snapshot or SSE.

# Dao Web HUD Design

Date: 2026-07-30  
Status: Approved through the user's standing instruction to use the recommended path  
Visual direction: A — operations cockpit

## Goal

Expose Dao's multi-session Agent state, route health, prompt-cache effectiveness, usage, and failures in a browser UI that works independently of Devin, Codex, or any other client.

The first release must run inside the existing Dao process on `127.0.0.1:8955`, reuse current runtime state, remain read-only, and never expose credentials, raw prompts, full paths, or raw tool output.

## Selected approach

Add the Web HUD to the existing Origin server:

```text
IDE / Agent clients
        |
        v
Dao runtime :8955
  |-- agent-status summaries
  |-- route / circuit health
  |-- prompt-cache usage
  |-- alert summaries
  |
  +-- Web HUD projection (pure, sanitized)
        |-- GET /origin/hud/snapshot
        |-- GET /origin/hud/events   (SSE)
        +-- GET /hud                 (static UI)
```

Alternatives rejected:

1. A separate HUD server would add another port, lifecycle, authentication boundary, and failure mode.
2. Reusing the Devin Webview would be faster initially but would keep the HUD tied to Devin and unavailable to Codex or other IDEs.

## Scope

### Included

- Desktop operations-cockpit layout selected by the user.
- Responsive single-session layout on narrow screens.
- Aggregate KPIs: active sessions, warnings, calls, input/output tokens, cache reads/writes, recent hit rate, and open circuits.
- Session list and selected-session detail: surface, goal, workspace basename, mode, phase, todo progress, verification, failure indicators, route, and freshness.
- Channel health: provider, alive/degraded/circuit state, age, actual model where available, and recent cache effectiveness.
- Recent sanitized request samples: provider, model, cache mode, TTL, breakpoint count, cache read/write, hit rate, stable-prefix size/hash, downgrade, and time.
- SSE live updates with reconnect and a bounded polling fallback.
- Browser-local session selection and pinning with `localStorage`; no server-side mutation.
- Loading, empty, stale, disconnected, and partial-runtime states.

### Deferred

- Server-side Auto/On/Off mutation from the Web HUD.
- Public-network access and remote authentication.
- Raw traces, prompts, file paths, tool arguments, tool results, or API keys.
- Full Codex tool lifecycle ingestion. The schema includes a `surface` field so Codex/App Server or hook data can be added later.
- Historical database and long-range charts. The first release displays current memory state and bounded recent samples.

## Components

### `core/web_hud_projection.js`

A pure module that accepts already-available runtime inputs and returns a frozen, JSON-safe snapshot.

Responsibilities:

- Validate and bound every input field.
- Hash internal session keys before exposure.
- Reduce workspace paths to basenames.
- Aggregate usage and cache metrics.
- Derive provider health and warning levels.
- Merge Agent summaries, route truth, circuits, prompt-cache policy status, and recent cache samples.
- Produce deterministic ordering for stable tests and efficient change detection.

It does not depend on HTTP, VS Code, filesystem access, or browser APIs.

### `core/web_hud_service.js`

A small runtime service with injected data readers.

Responsibilities:

- Build one snapshot at a bounded cadence, initially 2 seconds.
- Keep one shared timer regardless of connected browser count.
- Broadcast only when the snapshot changes, plus a 15-second SSE heartbeat.
- Limit concurrent local clients and remove disconnected clients immediately.
- Start lazily on the first subscriber and stop when no subscribers remain.
- Return a current snapshot synchronously for the JSON endpoint.

### Origin endpoints

- `GET /hud` serves the application shell.
- `GET /hud/web-hud.css` and `GET /hud/web-hud.js` serve static assets.
- `GET /origin/hud/snapshot` returns one sanitized snapshot.
- `GET /origin/hud/events` returns SSE events named `snapshot` and heartbeat comments.

All HUD routes reject non-loopback clients with HTTP 403. Responses use `Cache-Control: no-store`, a restrictive CSP, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.

### Browser assets

- `ui/web-hud.html`
- `ui/web-hud.css`
- `ui/web-hud.js`

The client has no framework or external CDN dependency. It renders untrusted values through `textContent`, never `innerHTML`, and stores only the selected hashed session id locally.

## Snapshot contract

```json
{
  "version": 1,
  "generatedAt": 0,
  "runtime": {
    "healthy": true,
    "mode": "invert",
    "port": 8955,
    "connection": "live"
  },
  "totals": {
    "activeSessions": 0,
    "warnings": 0,
    "calls": 0,
    "input": 0,
    "output": 0,
    "cached": 0,
    "cacheWrite": 0,
    "hitRate": 0,
    "openCircuits": 0
  },
  "sessions": [],
  "providers": [],
  "recentRequests": [],
  "cachePolicy": {
    "activeWarmups": 0,
    "warmupSent": 0,
    "warmupFailed": 0,
    "unsupportedProviderCount": 0
  }
}
```

Session ids are one-way hashes. Recent requests never contain prompt text, raw cache keys, raw session identifiers, credentials, or full paths.

## Visual design

Desktop layout:

1. Top bar: Dao identity, live/disconnected state, current mode, refresh age.
2. KPI strip: sessions, cache hit, cache read, warnings, tokens, circuits.
3. Left rail: active and recent sessions with source, phase, progress, verification, and warning dot.
4. Center: selected task goal, progress, route, cache facts, verification, and latest safe activity.
5. Right rail: provider health and circuit state.
6. Bottom table: bounded recent cache/request samples.

Narrow screens collapse to the selected-session design: KPI strip, horizontal session selector, detail, providers, and recent requests.

The visual language is a compact dark operations console with restrained blue, green, amber, and red status colors. It uses system fonts, high contrast, no gradients, and visible keyboard focus.

## Data flow

1. Router and Agent Status continue owning their existing state.
2. The Web HUD service reads through narrow runtime facades.
3. The projection module sanitizes and aggregates a new snapshot.
4. The service compares its deterministic signature with the previous snapshot.
5. Changed snapshots are broadcast over SSE.
6. The browser reconnects automatically; after repeated SSE failure it polls `/origin/hud/snapshot` every 5 seconds.

The Web HUD never becomes the source of truth.

## Error handling

- Missing runtime module: return a valid empty snapshot with `healthy=false`.
- One failing reader: preserve the remaining sections and add a bounded component warning.
- SSE disconnect: remove the client without affecting routing.
- Slow client: drop the update rather than buffer without limit; the next snapshot supersedes it.
- Invalid or oversized field: discard or truncate it in the projection layer.
- Static asset failure: return a small JSON 404 without leaking filesystem paths.

HUD failures must never interrupt model routing.

## Testing

### Projection tests

- Deterministic aggregation and ordering.
- Session-key hashing and path basename reduction.
- Raw prompt, credential, cache-key, and tool-output leakage checks.
- Cache hit-rate calculation for OpenAI and Anthropic token semantics.
- Active/stale/warning derivation and malformed-input tolerance.

### Service tests

- Shared timer, change coalescing, heartbeat, disconnect cleanup, and client cap.
- Reader failure isolation.

### HTTP tests

- HTML/assets, snapshot JSON, and SSE framing.
- Loopback accepted; non-loopback rejected.
- Security headers and no-store behavior.

### Browser tests

- Static syntax/CSP compliance.
- Rendering of loading, empty, live, warning, and disconnected fixtures.
- Session selection and local pin restoration.
- Responsive layout smoke check.

### Regression

- Agent HUD, prompt-cache policy/router, context strategy, cache resilience, Webview syntax, and `npm test` remain green.

## Deployment and acceptance

1. Sync new modules/assets and narrow Origin changes into the installed extension.
2. Reload Devin Window because JavaScript changes require a new extension host.
3. Confirm `:8955` has a new healthy process.
4. Open `http://127.0.0.1:8955/hud` in the in-app browser.
5. Exercise at least two sessions and one real cached request.
6. Confirm live updates, per-session isolation, cache metrics, responsive layout, reconnect, and absence of secrets/full paths.

## Success criteria

- The HUD is usable without Devin-specific APIs.
- A human can identify the active task, route, provider health, cache effectiveness, and failures within one screen.
- Updates arrive within 3 seconds without refreshing.
- Multiple sessions cannot overwrite one another.
- No raw secrets, prompts, full paths, or raw session ids cross the HTTP boundary.
- Closing the HUD leaves no active polling timer or routing side effect.

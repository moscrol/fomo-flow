# Dao Desktop Native Components

Date: 2026-08-09
Status: implemented as the primary macOS workspace

## Decision

Dao Desktop does not make the legacy Dao Web page the main Electron surface.
The main React/Vite workspace loads one capability at a time and keeps each
capability's state and actions close to its UI. The existing `dao-flow://control/`
window remains a compatibility fallback for legacy workflows only.

```text
React sidebar selection
  -> lazy native component
      -> desktopHost.requestControl(path, method, body)
          -> validated Electron IPC
              -> 127.0.0.1 Dao Origin /origin/* endpoint
```

## Component map

| Component        | Dao capability loaded independently                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HUD              | sanitized Web HUD snapshot: runtime strip, six KPIs, sessions/detail, provider health, task reliability, recent requests; plus native control-plane alerts/traces |
| Essence          | mode, canon, preview, custom SP, handoff                                                                                                                          |
| Providers        | provider CRUD, model discovery, health probe, protocol/usage/cache/sync presentation, handoff preview                                                             |
| Routes           | model route CRUD, reasoning level, fallback strategy, official-family catalog, external-model inventory, actual-route and bridge-sync presentation                |
| Reverse proxy    | enablement, prompt policy, exposed models, family tiers, local Base/four-protocol endpoints, key boundary and availability statistics                             |
| Tunnel           | quick/named tunnel, Cloudflare binding, relay lifecycle                                                                                                           |
| Protocol bridges | source provider/model to Chat/Responses/Anthropic/Gemini                                                                                                          |
| Custom models    | multi-channel model registry and capability settings, runtime route state, capability badges, sync status                                                         |
| Codex hot-route  | explicit provider/model/protocol/reasoning handoff                                                                                                                |
| Observability    | alerts, failures, traces, audit, backups, export                                                                                                                  |
| Connectors       | explicit handoff boundary for Codex, IDE, and clients                                                                                                             |

## Boundary rules

- Renderer code only receives sanitized loopback endpoints, masked provider
  status, and bounded presentation fields; full API keys and arbitrary
  filesystem paths never cross into the renderer.
- IPC accepts only fixed `GET`, `POST`, and `DELETE` requests under the
  allowlisted `/origin/*` prefixes and keeps requests on the active loopback
  origin.
- Sensitive actions (provider writes, public tunnels, Codex takeover, route
  deletion, and config rollback) require a visible component action.
- Importing an arbitrary local configuration file is intentionally left to the
  compatibility page until a native file-picker flow is designed.
- The compatibility page is never loaded by the primary React navigation.
- The HUD renderer consumes only `/origin/hud/snapshot` through the same allowlisted
  IPC boundary. Its projection normalizes and bounds display strings before React
  renders them; no Web HUD HTML, CSS, iframe, prompt, key, or full path is reused.
- Configuration presentation uses the existing JSON contracts rather than copying
  Web DOM. API keys are represented only by `hasKey`/masked status in native
  state; full-key clipboard actions stay on the compatibility workflow.
  Extension-host-only file-change capture is outside the standalone runtime
  contract and remains a compatibility workflow.

## Verification

The desktop package is checked with TypeScript, ESLint, Vitest, Vite/Electron
builds, loopback API boundary tests, and a packaged macOS smoke run. The HUD
component uses the same sanitized snapshot contract as the legacy page but
renders its own React view, so closing or bypassing the fallback window does
not affect runtime ownership.

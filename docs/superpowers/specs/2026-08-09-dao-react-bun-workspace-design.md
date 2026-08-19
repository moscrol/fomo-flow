# Dao React/Bun Workspace Design

Date: 2026-08-09
Status: Approved by user direction

## Decision

Dao Desktop will adopt the **React + Vite + Bun-oriented Electron workspace
stack** demonstrated by `NanmiCoder/cc-haha`, while keeping Dao's existing
local routing runtime as the source of truth.  We will not import cc-haha's
Claude Code server, session store, provider credentials, sidecars, terminal
agent, or third-party integrations.

The reference project is MIT-licensed.  Any source file copied or materially
adapted from it will retain the required copyright/license notice and be
listed in `desktop/THIRD_PARTY_NOTICES.md`.  Dao-specific components are new
code and use Dao's own service contracts.

## Why this replaces the initial vanilla shell

The initial Electron-vite/vanilla implementation proved the difficult part:
Dao can own its runtime, configuration, loopback endpoints, lifecycle, and
macOS package without VS Code.  Its renderer is intentionally thin, though,
and does not provide the durable workspace structure needed for all Dao
capabilities.

cc-haha's useful layer is its desktop product architecture:

- React components and Vite renderer for a stateful, resizable workspace;
- Electron main/preload separation with small validated IPC capabilities;
- a local-first service boundary rather than renderer-owned business logic;
- Bun-based authoring/build tooling for its desktop project; and
- activity, search, navigation, and view ownership patterns that scale beyond
  one embedded dashboard.

The current reference declares Electron, React + Vite, and Bun as its desktop
stack, and is MIT licensed.  Dao will use that stack and patterns—not its
Claude-specific runtime. [cc-haha repository](https://github.com/NanmiCoder/cc-haha)

## Alternatives considered

1. **Keep the vanilla Electron-vite wrapper.** Lowest migration cost, but
   leaves Dao as a HUD plus a separate legacy-style config window. Rejected.
2. **Fork all of cc-haha.** Fastest visual parity, but imports an unrelated
   Claude-agent server, many unnecessary sidecars, and maintenance liabilities.
   Rejected.
3. **Adopt its desktop stack and adapt its shell boundaries for Dao.** React
   components own Dao views; Electron owns capabilities; Dao's proven runtime
   stays local and independent. Recommended and selected.

## Target architecture

```text
Dao Flow.app
  Electron main (Bun-built TypeScript bundle)
    ├─ DaoDesktopRuntime (existing Node/CommonJS router + Origin server)
    ├─ typed, allowlisted IPC capability layer
    ├─ app/window/menu/secure navigation lifecycle
    └─ optional Bun toolchain only for development/build orchestration

  Electron preload
    └─ window.daoDesktop (small typed capability client; no Node or secrets)

  React + Vite renderer
    ├─ Workspace shell (sidebar, command/search, tabs, activity state)
    ├─ Overview component
    ├─ Live HUD component / compatibility surface
    ├─ Provider and route components
    ├─ Reverse-proxy and protocol components
    ├─ Observability component
    └─ explicit future Host Connector component

  Dao loopback Origin service
    ├─ /hud and HUD SSE/snapshot contracts
    ├─ /origin/ea/* configuration contracts
    ├─ /origin/revproxy/* runtime contracts
    └─ /v1/* local model APIs
```

The renderer never reads configuration files, starts servers, accesses a shell,
or receives credentials.  It accesses sanitized state through the existing
loopback APIs plus a limited Electron IPC bridge for window actions, explicit
external links, user-chosen file saves, and user-initiated local config reveal.

## Product surface

The first React workspace release contains the following navigable components:

| View | Dao capability | Initial implementation |
| --- | --- | --- |
| Overview | runtime health, bound port, provider and route summary | React query of sanitized runtime/HUD endpoints |
| Live HUD | live sessions, requests, channel health, tasks | existing `/hud` retained in a controlled compatibility view, followed by component extraction |
| Providers | provider add/edit/delete/probe | React adapter over `/origin/ea/*` |
| Routes | official-to-upstream mapping and health | React adapter over `/origin/ea/overview` and route APIs |
| Reverse proxy | status, local endpoint, handoff/export | React adapter over `/origin/revproxy/*` |
| Observability | request traces, alerts, config history | React adapter over existing sanitized projections |
| Connectors | Codex/IDE setup and restoration | explicit, disabled-by-default Phase 3 capability—not automatic behavior |

The `Cmd+K` command surface owns navigation and safe actions such as opening a
view, copying the local endpoint, retrying the runtime, or opening a selected
provider URL.  It never carries API keys or executes arbitrary commands.

## Bun and dependency policy

Bun is adopted as the pinned desktop package-manager/build entry point,
matching the reference's desktop workflow.  The application runtime remains
Electron's Node process because Dao's existing router is CommonJS and has
already been validated there.  Bun is not a required global installation for
end users and is not bundled as a hidden background service.

The migration pins the exact Bun release in the Desktop package, adds
`bun.lock`, and keeps reproducible npm commands as a temporary developer
fallback until CI and release packaging have been converted.  The final
macOS `.app` includes no cc-haha server process and no Bun daemon.

## Security and compatibility

- Preserve the initial Desktop configuration migration and loopback-only port
  policy; no configuration is read from the renderer.
- Keep Node integration off, context isolation and sandbox on, and validate
  every IPC payload by channel and caller window.
- Do not alter Codex, VS Code, Devin, certificates, macOS proxy state, tunnels,
  or third-party settings without a visible, user-triggered connector flow and
  a restore path.
- Preserve `/v1/*`, `/origin/*`, and `/hud` compatibility during migration so
  local SDK users are not tied to the new UI.
- Preserve existing VSIX behavior.  Dao Desktop gets its own user-data root.

## Delivery phases

1. **Workspace foundation:** replace the vanilla renderer with a React/Vite
   workspace, install a project-local Bun workflow, retain the proven
   `DaoDesktopRuntime`, and add the attribution notice.
2. **Dao view adapters:** add typed adapters and React views for overview,
   providers, routes, reverse proxy, and observability; retain the existing
   HUD as a compatibility view until its projection is componentized.
3. **Host connectors:** add explicit Codex/IDE setup, backup, confirmation,
   health, and restore flows.  No automatic interception.
4. **Release hardening:** code signing, notarization, updates, smoke tests,
   release automation, and then optional full HUD component replacement.

## Acceptance criteria for Phase 1 of this pivot

- `desktop/` is a React + Vite workspace with a Bun-first, reproducible build
  workflow and Mac Electron packaging.
- Dao's runtime starts and stops as before, with the Electron main process
  retaining ownership.
- A React shell presents Overview, Live HUD, Providers, Routes, Reverse Proxy,
  Observability, and Connectors navigation.
- Each rendered Dao value is sanitized and comes from an existing local
  contract; no provider key or raw config file reaches React state.
- The copied/adapted cc-haha portions have explicit MIT attribution.
- Existing desktop runtime tests, React component tests, build, packaged
  resource checks, and isolated macOS launch smoke all pass.

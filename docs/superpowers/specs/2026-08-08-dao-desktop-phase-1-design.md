# Dao Desktop Phase 1 Design

Date: 2026-08-08
Status: Approved

## Goal

Ship a macOS arm64 desktop application that starts Dao's local routing runtime itself, opens the existing live Web HUD in an Electron window, and exposes the current local OpenAI, Responses, Anthropic, Gemini, Origin, and HUD endpoints without requiring VS Code, Devin, or an already-running Dao process.

## Product boundary

Dao Desktop is a new delivery surface. The existing VSIX remains supported and must retain its current runtime behavior and configuration compatibility.

Phase 1 is the first of four independent releases:

1. Independent runtime: Electron owns startup, shutdown, configuration migration, the Origin server, routing, reverse proxy, and HUD.
2. Desktop control console: replace the VS Code configuration Webview with a native Electron renderer.
3. Host connectors: provide explicit, reversible setup for Codex, Devin, and other IDE clients that currently depend on VS Code APIs or host-specific interception.
4. macOS delivery: signing, notarization, update distribution, and release automation.

This document specifies Phase 1 only. It deliberately does not promise automatic IDE interception or a full configuration UI before their dedicated phases.

## Selected approach

Electron runs the existing Dao runtime in its main process and retains the loopback HTTP control plane for runtime compatibility. The first window loads the existing `/hud` page from that server. The renderer receives no Node.js access and does not become a second routing implementation.

```text
Dao Desktop.app
  Electron main process
    └─ DaoDesktopRuntime
         ├─ ExternalApiRuntime / dao_router
         ├─ Origin server (`source.js`)
         │    ├─ /origin/* control plane
         │    ├─ /v1/* standard model reverse proxy
         │    └─ /hud + snapshot/SSE endpoints
         └─ desktop state and log directories

  Electron renderer
    └─ existing Web HUD at http://127.0.0.1:<runtime-port>/hud

External local SDK clients
  └─ http://127.0.0.1:<runtime-port>/v1/*
```

### Alternatives rejected

1. **Electron wrapper around an existing Dao service.** Fastest, but it is not independent and fails when the VSIX or previous process is absent.
2. **Renderer-only IPC rewrite.** Removes HTTP from the UI but would duplicate a mature local control plane and break existing SDK clients before a replacement is ready.
3. **Forked daemon in Phase 1.** Gives stronger process isolation but adds restart, logging, code-signing, and IPC complexity before the embedded runtime has been proven stable.

The selected approach preserves the tested HTTP and SSE contracts while creating a clean future seam for a daemon if measured stability requires one.

## Technology and package layout

- Use the stable `electron-vite` 5.x line through `npm create @quick-start/electron@latest` with the `vanilla-ts` template. Do not start on electron-vite 6 beta.
- Create a top-level `desktop/` package. It owns Electron, packaging, preload, renderer bootstrap, and macOS-only metadata.
- Keep router, Origin, HUD projection, and protocol modules in the existing root `core/` and `vendor/` trees. Do not fork copies into the renderer.
- Package the runtime code and HUD assets as Electron resources. Runtime modules that rely on filesystem-relative `require()` calls must be available as unpacked resources, not only inside `app.asar`.
- Build a macOS arm64 `.app` and DMG. Universal, x64, signing, notarization, auto-update, and CI are Phase 4 scope.

## Runtime ownership and lifecycle

`DaoDesktopRuntime` is a Node-only boundary owned by the Electron main process. It has no renderer or VS Code dependency.

Its public lifecycle is intentionally narrow:

```js
await runtime.start();
runtime.status();
await runtime.stop();
```

`start()` must:

1. Resolve and prepare Desktop state directories.
2. Perform a one-time, non-destructive legacy configuration import when Desktop has no configuration yet.
3. Initialize routing with the Desktop configuration path.
4. Start the Origin server on a loopback-only port.
5. Return the effective port, public local endpoint, mode, and health state.

`stop()` must stop HTTP/SSE listeners, Origin-owned timers, reverse-proxy activity, and any desktop-owned watchers before Electron exits. A failed HUD, renderer, or BrowserWindow must never stop model routing; a failed router start must keep the window in a diagnosable unavailable state rather than pretending the app is healthy.

Electron starts the runtime before creating the main window and awaits orderly shutdown from `before-quit`. The application must guard against duplicate startup in the same process and must not call `process.exit()` from runtime modules.

## Configuration and state migration

The Desktop configuration root is Electron's macOS user-data directory:

```text
~/Library/Application Support/Dao Flow/
```

It contains a focused `config/` directory for provider configuration, reverse-proxy configuration, persisted runtime port choice, and future Desktop-only metadata. API keys stay on disk only in this private directory; files containing secrets use owner-only permissions where the platform permits them.

On first successful Desktop startup only:

1. Look for legacy `~/.codeium/dao-byok/配置.json` and `revproxy.json`.
2. Validate that each candidate is parseable JSON without logging values.
3. Copy valid candidates atomically into Desktop state, preserving the legacy files unchanged.
4. Record only the import timestamp and source kind in a Desktop audit record; never record credentials or complete legacy paths in the HUD.

After the import, Desktop uses its own files as the sole source of truth. It does not silently re-import or overwrite legacy configuration. A later manual import/export capability belongs to Phase 2.

The existing runtime currently resolves several paths through `os.homedir()` and `~/.codeium/dao-byok`. Phase 1 introduces explicit, injected configuration/state paths for `ExternalApiRuntime`, the router facade, and reverse-proxy configuration. Electron must not set global environment variables as a hidden configuration channel because it can coexist with a VSIX process under the same macOS user account.

## Ports and local API compatibility

The server binds only to `127.0.0.1` and `::1`. It prefers port `8955` for continuity with the current HUD URL. If that port is occupied, it chooses a safe available loopback port, persists the selected port for the next launch, and shows the actual endpoint in the application.

The existing routes remain compatible:

- `/hud`, `/origin/hud/snapshot`, and `/origin/hud/events` for the live dashboard.
- `/origin/*` for the existing local control plane.
- `/v1/*` and protocol-specific routes for local OpenAI, Responses, Anthropic, and Gemini clients.

The Electron window loads only the resolved loopback `/hud` origin. It never treats an external origin as a Dao renderer. The renderer's existing fetch and EventSource paths remain unchanged in Phase 1.

## Security boundary

The desktop window uses `nodeIntegration: false`, `contextIsolation: true`, and Electron sandboxing. Its preload exposes only narrow, app-owned operations required by the window lifecycle; it does not expose filesystem, shell, runtime configuration, secrets, arbitrary IPC, or Node globals.

The application denies arbitrary window creation and navigation. Opening an external URL requires an explicit user action and uses the operating system browser. The local HTTP server keeps its existing loopback checks, restrictive CSP, no-store responses, and sanitized HUD projection.

No Phase 1 code may silently modify IDE settings, install a certificate, alter the macOS proxy, or change a third-party client. Those actions require an explicit connector workflow with a reversible restore path in Phase 3.

## Desktop user experience

At launch, the user sees the existing Dao Web HUD as a normal desktop window with live session, channel health, task, and request updates. If the runtime cannot start, the window shows a clear local diagnostic state with the failed component and retry action; it must not reveal API keys, raw prompts, full local paths, raw tool output, or process environment values.

Phase 1 preserves the current HUD visual design and data contract. It does not force a React rewrite, nor does it expose the old VS Code configuration Webview as if it were a complete desktop configuration solution. Phase 2 moves provider, route, reverse-proxy, tunnel, protocol-bridge, custom-model, Codex hot-route, and observability controls into the Electron renderer.

### Desktop experience references

The open-source [cc-haha desktop workspace](https://github.com/NanmiCoder/cc-haha) is a reference for the shell around the HUD, not a runtime dependency or codebase to copy. Its useful patterns are:

- a local-first Electron host with a clearly separated main process, renderer, preload bridge, and local service;
- a resizable session/activity sidebar that keeps running work visible while the primary workspace changes;
- a command/search surface (for example, `Cmd+K`) for operations that should not require hunting through settings;
- explicit permission/connection states and traceable activity rather than opaque background actions;
- local persistence boundaries for UI preferences, session history, and host-owned state.

Dao keeps its existing vanilla HUD and CommonJS routing runtime in Phase 1. These patterns are recorded as Phase 2 shell requirements so the later control console can grow around the proven HUD without importing cc-haha's React/Bun stack or silently changing Dao's process and security boundaries.

## Failure behavior

- **Legacy import failure:** leave legacy data unchanged, start only if a safe Desktop default configuration can be created, and report a redacted actionable error.
- **Port collision:** do not kill another process; choose the configured fallback and report the effective local URL.
- **Router initialization failure:** keep the process alive for diagnosis, mark the runtime unhealthy, and do not open a misleading healthy HUD.
- **HUD/SSE client failure:** preserve routing and local SDK endpoints; the existing polling fallback remains available.
- **Electron window crash/reload:** retain the main-process runtime and reconnect the HUD when the renderer is recreated.
- **Application quit:** stop listeners and timers cleanly; never orphan a background process in Phase 1.

## Test strategy

Phase 1 adds focused tests before implementation for:

1. Desktop path resolution and first-run migration, including legacy preservation, atomic write behavior, and no secret leakage in status/error values.
2. Port selection and collision fallback without touching an existing listener.
3. `DaoDesktopRuntime` start/status/stop behavior with injected Origin and router fakes.
4. Configuration-path injection through the external runtime and reverse proxy.
5. Electron main-process startup policy and BrowserWindow security settings through extracted pure helpers where possible.
6. Existing HUD HTTP, service, projection, reverse-proxy, and routing regressions.

Manual macOS acceptance covers: fresh first launch, import of an existing safe configuration fixture, live HUD updates, standard local `/v1/models` access, graceful quit/relaunch, port collision, and confirmation that neither legacy config nor the VSIX process was modified.

## Phase 1 success criteria

- Dao Desktop launches on Apple Silicon without VS Code, Devin, or a previously running Dao process.
- The existing HUD opens in an Electron window and receives live updates within the existing SSE cadence.
- The Desktop-owned runtime exposes its local model API endpoints on a loopback port.
- Existing legacy configuration is safely imported once, then remains untouched.
- Credentials, raw prompts, full paths, and raw tool output do not cross into the renderer or logs.
- Closing Dao Desktop stops its listeners and leaves no detached process behind.
- Existing VSIX tests and targeted runtime/HUD tests remain green.

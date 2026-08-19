# Dao Desktop Control Console

Date: 2026-08-09
Status: superseded for the primary workspace by
[Dao Desktop Native Components](./2026-08-09-dao-desktop-native-components.md)

## Goal

Bring Dao's existing provider, route, reverse-proxy, protocol bridge, tunnel,
custom-model, and observability controls into Dao Desktop so the macOS app is
not merely a wrapper around the HUD.

## Historical compatibility approach

The Electron main process opens a second, sandboxed control-console window.
The console reuses the already-tested `ui/ea-config-html.js` renderer and talks
only to the Desktop-owned loopback Origin service.  It is delivered through a
private Electron protocol, rather than a VS Code Webview or a remote URL.

```text
Dao Flow menu / Cmd+, 
  -> sandboxed Dao control console
       -> /origin/ea/*, /origin/revproxy/*, /origin/* (loopback only)
       -> Desktop-owned config/配置.json and config/revproxy.json
```

This preserves the existing live configuration UI and HTTP contracts without
creating a second router implementation or requiring VS Code to be installed.

## Scope

- Add a Dao Flow menu action and `Cmd+,` shortcut to open the console.
- Reuse the existing controls for source prompt state, providers, routes,
  reverse proxy, tunnel, protocol bridge, custom models, and observability.
- Provide a narrow preload bridge for user-triggered external URLs, clipboard
  copy, handoff-document save, and opening the Desktop-owned configuration
  file.  It accepts a fixed allowlist of message shapes only.
- Keep the current HUD window independent: closing the console never stops the
  local router or model endpoints.

## Explicitly deferred host connectors

The legacy Codex hot-route panel and workspace file-change controls can modify
third-party client configuration or user workspaces.  They remain hidden in
the Desktop control console until a dedicated connector flow can present the
target, backup, confirmation, and restore action.  Dao Desktop must not change
`~/.codex`, IDE settings, certificates, or system proxy settings implicitly.

The underlying local model APIs continue to work; this only prevents an
unreviewable host-integration action from being presented as a Desktop setting.

## Security and validation

- The console uses the same `nodeIntegration: false`, context isolation,
  sandboxing, and navigation policy as the HUD.
- Its private `dao-flow://` page is the only non-loopback navigation allowed
  for that window; all HTTP(S) links are opened by macOS after a user click.
- The preload exposes no filesystem, shell, Electron, or arbitrary IPC API.
- Exported handoff text is size limited; filenames are reduced to a safe
  Markdown basename.  Errors and paths are not reflected into the renderer.

## Acceptance checks

1. `Cmd+,` opens the console without VS Code.
2. The console reads and writes the Desktop configuration through the local
   Origin endpoints, not the legacy configuration location.
3. External links, clipboard copy, config-file open, and handoff save work
   only after an action in the console.
4. Codex/IDE configuration is not touched when the Desktop app starts or the
   console opens.
5. Unit tests cover generated-page bridge injection, action validation,
   navigation policy, and Electron build/package checks.

# Dao Desktop Control Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the existing Dao Web control surface into the macOS Electron app while preserving Dao's existing HTTP contracts and keeping third-party client configuration changes explicit.

**Architecture:** The Electron main process creates a second `BrowserWindow` loaded from a private `dao-flow://control/` protocol. The protocol handler generates the existing `ui/ea-config-html.js` page with the Desktop-owned loopback port, so Provider, route, reverse-proxy, tunnel, protocol-bridge, custom-model, prompt, and observability actions continue to use the existing `/origin/*` contracts. A narrow preload bridge replaces the VS Code Webview host messages for external links, configuration-file opening, clipboard writes, and Markdown handoff saving; Codex/IDE workspace mutation messages are ignored and never exposed.

**Tech Stack:** Electron 39, Bun-built TypeScript main/preload, existing Node/CommonJS Dao Origin, existing JavaScript Dao Web control surface, Vitest, Node test runner, macOS arm64 electron-builder.

---

### Task 1: Lock the Desktop host-message contract

**Files:**
- Modify: `desktop/electron/ipc/channels.ts`
- Modify: `desktop/electron/ipc/capabilities.ts`
- Modify: `desktop/electron/preload.ts`
- Test: `desktop/electron/ipc/capabilities.test.ts`

- [ ] **Step 1: Write failing validation tests** for a bounded Markdown payload, safe filename, and rejection of unknown host messages.
- [ ] **Step 2: Run** `npm run test -- --run desktop/electron/ipc/capabilities.test.ts` and confirm the new cases fail.
- [ ] **Step 3: Add** a `controlSaveHandoff` IPC channel and expose `daoControlHost.openExternal`, `openConfig`, `copyText`, and `saveHandoff` from preload. Keep payload validation exact: HTTP(S) URL, text ≤ 2 MiB, basename-only Markdown filename ≤ 120 characters.
- [ ] **Step 4: Re-run** the focused Vitest file and confirm all cases pass.
- [ ] **Step 5: Commit** `feat: add desktop control host contract`.

### Task 2: Generate the reusable Dao Web page for Desktop

**Files:**
- Modify: `ui/ea-config-html.js`
- Test: `test/dao-desktop-control-html.test.js`

- [ ] **Step 1: Write a failing test** that calls `getEaConfigHtml(port, nonce, { desktop: true, foldBridge: true })` and asserts the generated page contains the port, a nonce-protected Desktop `acquireVsCodeApi` shim, and no Codex/IDE host implementation.
- [ ] **Step 2: Run** `node --test test/dao-desktop-control-html.test.js` and confirm failure.
- [ ] **Step 3: Add** an optional Desktop bridge script inside the existing nonce-protected script tag. Map only `openExternal`, `openConfigJson`, `copyHandoff`, and `saveHandoff`; make `codexChanges*`, `refreshDevinModels`, and `focusEssence` no-ops. Preserve the default VS Code behavior when `opts.desktop` is absent.
- [ ] **Step 4: Re-run** the focused test and the existing `test/dao-desktop-package-layout.test.js`.
- [ ] **Step 5: Commit** `feat: adapt Dao Web controls for Electron host`.

### Task 3: Add the private Electron control window

**Files:**
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/electron/services/navigation.ts`
- Test: `desktop/electron/services/navigation.test.ts`
- Test: `desktop/electron/main.control.test.ts`

- [ ] **Step 1: Write failing tests** for `dao-flow://control/` allowance, external-navigation blocking, and idempotent control-window creation.
- [ ] **Step 2: Run** the focused Vitest files and confirm failure.
- [ ] **Step 3: Register** `dao-flow` as a privileged secure standard scheme before `app.ready`; serve only the generated checked HTML for `/control/`. Create one reusable control `BrowserWindow` with context isolation, sandbox, no Node integration, and a loopback-only navigation policy.
- [ ] **Step 4: Add** `openControlWindow()` to the Dao Flow menu and `CmdOrCtrl+,`; start/retry the Desktop runtime before loading the page, and focus the existing window instead of opening duplicates.
- [ ] **Step 5: Re-run** focused tests and build the Electron main/preload bundles.
- [ ] **Step 6: Commit** `feat: add Electron Dao Web control window`.

### Task 4: Implement bounded host actions and lifecycle cleanup

**Files:**
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/electron/ipc/capabilities.ts`
- Modify: `desktop/electron/preload.ts`
- Test: `desktop/electron/main.control.test.ts`

- [ ] **Step 1: Write failing tests** for external URL forwarding, configuration-file opening, clipboard writes, Markdown save path sanitization, and cleanup when the control window closes.
- [ ] **Step 2: Run** the focused tests and confirm failure.
- [ ] **Step 3: Implement** `dialog.showSaveDialog` with a Documents-directory default, safe basename normalization, `.md` enforcement, bounded UTF-8 content, and no renderer-provided arbitrary path. Route user-clicked external URLs through `shell.openExternal` only.
- [ ] **Step 4: Ensure** closing the control window never stops `DaoDesktopRuntime`; only application quit stops the runtime.
- [ ] **Step 5: Re-run** all Electron tests and inspect the generated HTML through the protocol handler.
- [ ] **Step 6: Commit** `feat: secure Dao Web host actions`.

### Task 5: Package and verify the full control surface

**Files:**
- Modify: `desktop/README.md`
- Modify: `desktop/THIRD_PARTY_NOTICES.md`
- Test: `test/dao-desktop-package-layout.test.js`
- Test: `test/dao-desktop-smoke.test.js`

- [ ] **Step 1: Add** package-layout assertions for `ui/ea-config-html.js` and all `ea-config-client-*.js` resources.
- [ ] **Step 2: Add** a packaged smoke check that opens the control protocol, finds the nine Dao Web tabs, and confirms the page can request the loopback overview endpoint.
- [ ] **Step 3: Run** `npm run lint`, `npm run typecheck`, `npm run test -- --run`, the root Desktop tests, `npm run build`, and `npm run build:electron`.
- [ ] **Step 4: Build** `npm run dist:mac`, run `hdiutil verify`, and launch the unpacked arm64 app with an isolated user-data directory to verify the control window and HUD independently.
- [ ] **Step 5: Update** the README to distinguish full Dao Web controls from the intentionally deferred Codex/IDE connector actions.
- [ ] **Step 6: Commit** `feat: complete Dao Web control console`.

---

## Self-review

- Provider, route, reverse-proxy, tunnel, protocol-bridge, custom-model, prompt, and observability controls are covered by reusing the existing generated HTML and its `/origin/*` calls.
- External navigation, config opening, clipboard, and handoff saving have explicit bounded host actions; no generic IPC message channel is exposed.
- Codex/IDE file and configuration mutation remains deferred and cannot be triggered by the Desktop console.
- Runtime ownership and configuration isolation remain unchanged from the existing Desktop commit.

# Dao Desktop Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS arm64 Electron application that owns the Dao routing runtime and opens the existing live Web HUD without VS Code.

**Architecture:** A stable `electron-vite`/`vanilla-ts` package under `desktop/` hosts a Node-only `DaoDesktopRuntime` in Electron main. The main process injects Desktop-owned configuration paths into the existing CommonJS router and Origin server, starts a loopback HTTP service, and loads its `/hud` URL in a sandboxed renderer. The existing VSIX and legacy files remain independent and unchanged.

**Tech Stack:** Electron, electron-vite 5.x, Vite, TypeScript, vanilla DOM renderer, Node.js CommonJS runtime, electron-builder, Node `assert` tests.

---

## Context and file map

The repository is primarily a VS Code extension. The current HUD is served by `vendor/bundled-origin/source.js` and uses relative `fetch`/`EventSource` calls from `ui/web-hud.js`; it must remain the Phase 1 renderer. `vendor/外接api/runtime.js` and `vendor/外接api/core/revproxy.js` currently resolve configuration through the shared `~/.codeium/dao-byok` directory, so Desktop needs explicit path injection before `source.js` is required. `cc-haha` is an experience reference only: borrow its separated Electron main/preload/local-service boundary, activity-oriented shell, command palette direction, and explicit state surfaces; do not import its React/Bun runtime.

The implementation creates these focused units:

| Path | Responsibility |
| --- | --- |
| `desktop/` | Electron-vite package, renderer bootstrap, preload, packaging metadata, macOS scripts |
| `core/dao_desktop_paths.js` | User-data paths, one-time legacy import, atomic secret-file writes, redacted diagnostics |
| `core/dao_desktop_port.js` | Loopback port preference, collision-safe reservation, persisted port |
| `core/dao_desktop_runtime.js` | Main-process orchestration and sanitized status contract |
| `test/dao-desktop-*.test.js` | Deterministic path, port, lifecycle, security, package, and smoke tests |
| `docs/superpowers/specs/2026-08-08-dao-desktop-phase-1-design.md` | Approved boundary and cc-haha reference decisions |

Before each commit, inspect only the intended paths with `git diff --check` and leave all unrelated pre-existing worktree changes untouched.

### Task 1: Scaffold the Electron-vite package

**Files:**
- Create: `desktop/` from the official quick-start `vanilla-ts` template
- Modify: `desktop/package.json`, root `package.json`, `.gitignore`
- Test: `desktop/src/main/window-policy.test.ts`

- [ ] **Step 1: Generate the stable template**

Run:

```bash
npm create @quick-start/electron@latest desktop -- --template vanilla-ts
```

Choose the npm package manager when prompted, then verify that `desktop/src/main`, `desktop/src/preload`, and `desktop/src/renderer` exist and that the generated scripts use `electron-vite` 5.x. Do not select React, Svelte, Solid, or a beta template.

- [ ] **Step 2: Set the Desktop package identity and scripts**

Edit `desktop/package.json` so the package has the existing Dao version and macOS identity, while keeping runtime modules external to Vite:

```json
{
  "name": "dao-flow-desktop",
  "productName": "Dao Flow",
  "version": "9.9.423",
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "electron-vite dev",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "electron-vite build",
    "pack:mac": "electron-builder --mac dir --arm64 --publish never",
    "dist:mac": "electron-builder --mac dmg --arm64 --publish never",
    "test": "vitest run"
  },
  "build": {
    "appId": "com.daoflow.desktop",
    "productName": "Dao Flow",
    "asar": true,
    "directories": { "output": "release" }
  }
}
```

Keep the generated Electron/Vite versions pinned by the lockfile. Add no updater, remote publisher, or external provider SDK in Phase 1.

- [ ] **Step 3: Add root convenience commands without changing VSIX commands**

Add these entries to the existing root `package.json` scripts object:

```json
"desktop:dev": "npm --prefix desktop run dev",
"desktop:typecheck": "npm --prefix desktop run typecheck",
"desktop:build": "npm --prefix desktop run build",
"desktop:pack:mac": "npm --prefix desktop run pack:mac"
```

Add `desktop/node_modules/`, `desktop/dist/`, `desktop/dist-electron/`, and `desktop/release/` to `.gitignore`; do not ignore source files or lockfiles.

- [ ] **Step 4: Verify the scaffold before integrating runtime code**

Run:

```bash
npm --prefix desktop install
npm --prefix desktop run typecheck
npm --prefix desktop run build
```

Expected: typecheck and build exit 0 and produce `desktop/dist-electron/main.js` plus a renderer bundle. Commit only generated Desktop files and the root script/ignore additions:

```bash
git add desktop package.json .gitignore
git diff --cached --check
git commit -m "build: scaffold Dao Desktop with electron-vite"
```

### Task 2: Implement Desktop paths and one-time configuration migration

**Files:**
- Create: `core/dao_desktop_paths.js`
- Create: `test/dao-desktop-paths.test.js`

- [ ] **Step 1: Write failing path and migration tests**

Use Node's built-in test runner and a temporary fixture directory. The tests must assert the exact public contract:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveDesktopPaths,
  prepareDesktopState,
  redactDesktopError,
} = require('../core/dao_desktop_paths');

test('resolves macOS userData paths without reading real user config', () => {
  const paths = resolveDesktopPaths({
    userDataDir: '/tmp/dao-user-data',
    homeDir: '/tmp/dao-home',
  });
  assert.equal(paths.root, '/tmp/dao-user-data');
  assert.equal(paths.configPath, '/tmp/dao-user-data/config/配置.json');
  assert.equal(paths.revproxyPath, '/tmp/dao-user-data/config/revproxy.json');
  assert.equal(paths.portPath, '/tmp/dao-user-data/runtime/port.json');
  assert.equal(paths.auditPath, '/tmp/dao-user-data/runtime/import-audit.json');
});

test('imports valid legacy files once and preserves their bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-desktop-paths-'));
  const home = path.join(root, 'home');
  const userData = path.join(root, 'user-data');
  fs.mkdirSync(path.join(home, '.codeium', 'dao-byok'), { recursive: true });
  const legacyConfig = path.join(home, '.codeium', 'dao-byok', '配置.json');
  const legacyProxy = path.join(home, '.codeium', 'dao-byok', 'revproxy.json');
  const configBytes = '{"provider":"fixture","apiKey":"secret"}\n';
  const proxyBytes = '{"enabled":true}\n';
  fs.writeFileSync(legacyConfig, configBytes, { mode: 0o600 });
  fs.writeFileSync(legacyProxy, proxyBytes, { mode: 0o600 });
  const paths = resolveDesktopPaths({ userDataDir: userData, homeDir: home });

  const first = await prepareDesktopState(paths);
  assert.equal(first.imported.config, true);
  assert.equal(fs.readFileSync(legacyConfig, 'utf8'), configBytes);
  assert.equal(fs.readFileSync(paths.configPath, 'utf8'), configBytes);
  assert.equal(fs.readFileSync(paths.revproxyPath, 'utf8'), proxyBytes);

  const second = await prepareDesktopState(paths);
  assert.deepEqual(second.imported, { config: false, revproxy: false });
});

test('redacts secrets and absolute legacy paths from diagnostics', () => {
  const message = redactDesktopError(new Error('apiKey=secret /Users/alice/.codeium/dao-byok/配置.json'));
  assert.match(message, /apiKey=\[redacted\]/);
  assert.doesNotMatch(message, /secret|\/Users\/alice/);
});
```

- [ ] **Step 2: Run the new tests and verify the expected failure**

Run: `node --test test/dao-desktop-paths.test.js`

Expected: FAIL because `core/dao_desktop_paths.js` is not present.

- [ ] **Step 3: Implement deterministic paths, validation, and atomic import**

Export the following CommonJS functions from `core/dao_desktop_paths.js`:

```js
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function resolveDesktopPaths({ userDataDir, homeDir = os.homedir() } = {}) {
  const root = path.resolve(userDataDir || path.join(homeDir, 'Library', 'Application Support', 'Dao Flow'));
  return {
    root,
    configDir: path.join(root, 'config'),
    runtimeDir: path.join(root, 'runtime'),
    configPath: path.join(root, 'config', '配置.json'),
    revproxyPath: path.join(root, 'config', 'revproxy.json'),
    portPath: path.join(root, 'runtime', 'port.json'),
    auditPath: path.join(root, 'runtime', 'import-audit.json'),
    logPath: path.join(root, 'runtime', 'desktop.log'),
    legacyDir: path.join(homeDir, '.codeium', 'dao-byok'),
  };
}

async function prepareDesktopState(paths, deps = {}) { /* mkdir, validate JSON, copy with .tmp + rename, chmod 600, audit */ }
function redactDesktopError(error) { /* replace apiKey/token/authorization values and absolute paths */ }

module.exports = { resolveDesktopPaths, prepareDesktopState, redactDesktopError };
```

`prepareDesktopState` must create `configDir` and `runtimeDir`, skip import when the destination already exists, parse legacy JSON before copying, write to a sibling `.tmp` file with mode `0o600`, `fsync` and rename, then write an audit object containing only `{ version: 1, importedAt, config: boolean, revproxy: boolean }`. It must never throw away legacy bytes or include credential values in errors. Use dependency injection for `fs/promises` and `now` in tests rather than reading the real home directory.

- [ ] **Step 4: Run the path tests and inspect permissions**

Run: `node --test test/dao-desktop-paths.test.js`

Expected: all three tests PASS; destination files have owner-only permissions on macOS. Commit:

```bash
git add core/dao_desktop_paths.js test/dao-desktop-paths.test.js
git diff --cached --check
git commit -m "feat: add Dao Desktop state migration"
```

### Task 3: Add loopback port reservation and persistence

**Files:**
- Create: `core/dao_desktop_port.js`
- Create: `test/dao-desktop-port.test.js`

- [ ] **Step 1: Write the collision and persistence tests**

The pure API is:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { reserveDesktopPort, readPersistedPort, writePersistedPort } = require('../core/dao_desktop_port');

test('prefers 8955 when it is free and binds loopback only', async () => {
  const port = await reserveDesktopPort({ preferred: 8955, candidates: [8955, 8956] });
  assert.equal(port, 8955);
});

test('falls back without touching an occupied listener', async () => {
  const blocker = net.createServer().listen(8955, '127.0.0.1');
  await new Promise(resolve => blocker.once('listening', resolve));
  const port = await reserveDesktopPort({ preferred: 8955, candidates: [8955, 8956] });
  assert.equal(port, 8956);
  assert.equal(blocker.listening, true);
  await new Promise(resolve => blocker.close(resolve));
});

test('accepts only valid persisted loopback ports', async () => {
  await writePersistedPort('/tmp/dao-port.json', 8957);
  assert.equal(await readPersistedPort('/tmp/dao-port.json'), 8957);
  await writePersistedPort('/tmp/dao-port.json', 70000).catch(error => assert.match(error.message, /port/i));
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test test/dao-desktop-port.test.js`

Expected: FAIL because the port module does not exist.

- [ ] **Step 3: Implement reservation without killing processes**

Implement `reserveDesktopPort({ preferred = 8955, persisted, candidates = [] } = {})` by trying `net.createServer().listen(port, '127.0.0.1')`, closing the probe immediately, and returning the first valid port from `[preferred, persisted, ...candidates]` with duplicates removed. A failed `EADDRINUSE` advances to the next candidate; any other error is rethrown. `writePersistedPort` writes `{ version: 1, port }` atomically and `readPersistedPort` returns `null` for missing or invalid JSON. Never call `kill`, `lsof`, or a broad process scan.

- [ ] **Step 4: Run and commit the port tests**

Run: `node --test test/dao-desktop-port.test.js`

Expected: all tests PASS and the blocker remains listening. Commit:

```bash
git add core/dao_desktop_port.js test/dao-desktop-port.test.js
git diff --cached --check
git commit -m "feat: reserve Dao Desktop loopback ports safely"
```

### Task 4: Inject Desktop configuration into the existing runtimes

**Files:**
- Modify: `vendor/外接api/runtime.js:48-60, 740`
- Modify: `vendor/外接api/core/revproxy.js:3261`
- Create: `test/dao-desktop-config-injection.test.js`

- [ ] **Step 1: Add failing injection tests**

Use fixture paths under a temporary directory and assert that no environment variable is needed:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtime = require('../vendor/外接api/runtime');
const revproxy = require('../vendor/外接api/core/revproxy');

test('runtime and reverse proxy expose explicit configuration hooks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-desktop-config-'));
  const configPath = path.join(root, '配置.json');
  const proxyPath = path.join(root, 'revproxy.json');
  runtime.configure({ configPath });
  revproxy.configure({ configPath: proxyPath });
  assert.equal(runtime.getConfiguredConfigPath(), configPath);
  assert.equal(revproxy.getConfiguredConfigPath(), proxyPath);
});
```

- [ ] **Step 2: Run the injection test and verify failure**

Run: `node --test test/dao-desktop-config-injection.test.js`

Expected: FAIL because `configure` and the inspection methods are not exported.

- [ ] **Step 3: Implement opt-in path hooks while preserving VSIX fallbacks**

Add module-scoped configured paths and exports with this shape:

```js
let _configuredConfigPath = null;
function configure(opts = {}) {
  if (opts.configPath !== undefined) _configuredConfigPath = path.resolve(String(opts.configPath));
  return _configuredConfigPath;
}
function getConfiguredConfigPath() { return _configuredConfigPath; }
function _resolveConfigPath() {
  if (_configuredConfigPath && fs.existsSync(_configuredConfigPath)) return _configuredConfigPath;
  // retain the existing DAO_BYOK_CONFIG, bundled, and ~/.codeium fallback order
}
```

Apply the same opt-in hook to `revproxy.js`'s `_cfgPath()`. `configure` must not mutate `process.env`, and calling it with no path must restore the existing fallback behavior. Export only `configure` and `getConfiguredConfigPath` in addition to the existing public exports. Ensure `ExternalApiRuntime` captures the injected path at construction and that a Desktop configure call happens before `runtime.ensure()` or `source.js` is required.

- [ ] **Step 4: Run existing runtime tests plus the new contract test**

Run:

```bash
node --test test/dao-desktop-config-injection.test.js
node vendor/外接api/core/dao-test.js --quick
```

Expected: both exit 0; existing VSIX fallback-path tests remain unchanged. Commit:

```bash
git add vendor/外接api/runtime.js vendor/外接api/core/revproxy.js test/dao-desktop-config-injection.test.js
git diff --cached --check
git commit -m "feat: inject Dao Desktop provider paths"
```

### Task 5: Make Origin lifecycle desktop-safe

**Files:**
- Modify: `vendor/bundled-origin/source.js:11300-11540`
- Create: `test/dao-origin-lifecycle.test.js`

- [ ] **Step 1: Write lifecycle tests against an isolated fake runtime**

Test the exported `start({ host, port, profile: 'desktop' })` and `stop()` contract without binding a public interface:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const origin = require('../vendor/bundled-origin/source');

test('desktop profile starts on loopback and reports a listening server', async () => {
  const result = await origin.start({ host: '127.0.0.1', port: 0, profile: 'desktop', mode: 'invert' });
  assert.equal(result.host, '127.0.0.1');
  assert.equal(result.profile, 'desktop');
  assert.ok(Number.isInteger(result.port) && result.port > 0);
  await origin.stop();
});

test('stop is idempotent and clears desktop-owned timers/bridges', async () => {
  await origin.stop();
  await origin.stop();
  assert.equal(origin.status().running, false);
});
```

- [ ] **Step 2: Run the lifecycle tests and capture the current failure**

Run: `node --test test/dao-origin-lifecycle.test.js`

Expected: the current start result lacks the desktop profile/status contract or leaves a bridge/timer alive.

- [ ] **Step 3: Add a desktop profile and complete shutdown**

Keep the existing default behavior for the VSIX. For `profile === 'desktop'`, suppress the `server.on('listening')` automatic `_brgRelayAutoStart()` and delayed `_brgAutoConnect()` calls unless an explicit `enableExternalBridge` option is true. Return `{ host, port, profile, mode, running: true }` from `start`. Extend `stop` to clear the delayed-connect timer, call `_brgStopTunnel(false)`, stop any relay client, close/reset `_h2Server`, stop Codex guards, and close the HTTP server before resolving. Guard repeated `start` calls by returning the existing server state and make repeated `stop` calls no-ops.

Use a named timer variable and a small status helper rather than changing route handlers:

```js
let _desktopProfile = false;
let _desktopConnectTimer = null;
function status() {
  return { running: Boolean(server?.listening), profile: _desktopProfile ? 'desktop' : 'vsix' };
}
```

- [ ] **Step 4: Run focused Origin/HUD regressions and commit**

Run:

```bash
node --test test/dao-origin-lifecycle.test.js test/web-hud-http.test.js test/web-hud-service.test.js
```

Expected: all tests PASS, including the existing default VSIX startup path. Commit:

```bash
git add vendor/bundled-origin/source.js test/dao-origin-lifecycle.test.js
git diff --cached --check
git commit -m "feat: harden Origin lifecycle for Desktop"
```

### Task 6: Build the main-process Desktop runtime orchestrator

**Files:**
- Create: `core/dao_desktop_runtime.js`
- Modify: `core/dao_desktop_paths.js`, `core/dao_desktop_port.js`
- Create: `test/dao-desktop-runtime.test.js`

- [ ] **Step 1: Define the injected dependency contract and failing tests**

The orchestrator must be testable without Electron, network, or real user files:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DaoDesktopRuntime } = require('../core/dao_desktop_runtime');

test('starts dependencies in configuration-before-Origin order', async () => {
  const calls = [];
  const runtime = new DaoDesktopRuntime({
    userDataDir: '/tmp/dao-runtime-fixture',
    deps: {
      prepareState: async () => calls.push('state'),
      configureExternal: () => calls.push('external'),
      configureRevproxy: () => calls.push('revproxy'),
      startOrigin: async options => { calls.push('origin'); return { ...options, port: 8955, running: true }; },
      stopOrigin: async () => calls.push('stop-origin'),
    },
  });
  const status = await runtime.start();
  assert.deepEqual(calls.slice(0, 4), ['state', 'external', 'revproxy', 'origin']);
  assert.equal(status.url, 'http://127.0.0.1:8955');
  assert.equal(runtime.status().healthy, true);
  await runtime.stop();
  assert.deepEqual(calls.slice(-1), ['stop-origin']);
});

test('returns a redacted unhealthy status when startup fails', async () => {
  const runtime = new DaoDesktopRuntime({
    userDataDir: '/tmp/dao-runtime-failure',
    deps: { prepareState: async () => {}, startOrigin: async () => { throw new Error('apiKey=hidden'); } },
  });
  await assert.rejects(runtime.start(), /apiKey=\[redacted\]/);
  assert.equal(runtime.status().healthy, false);
  assert.doesNotMatch(JSON.stringify(runtime.status()), /hidden/);
});
```

- [ ] **Step 2: Run the tests and verify the missing orchestrator failure**

Run: `node --test test/dao-desktop-runtime.test.js`

Expected: FAIL because `DaoDesktopRuntime` is not defined.

- [ ] **Step 3: Implement the narrow lifecycle and status API**

Implement:

```js
class DaoDesktopRuntime {
  constructor({ userDataDir, homeDir, deps = {} } = {}) { /* resolve paths and merge defaults */ }
  async start() { /* state -> configure -> reserve port -> Origin start; memoize promise */ }
  status() { return { healthy, running, port, url, profile: 'desktop', imported, error }; }
  async stop() { /* await pending start, then Origin stop once */ }
}
```

The default dependencies lazily require `vendor/外接api/runtime.js`, `vendor/外接api/core/revproxy.js`, and `vendor/bundled-origin/source.js` only after `prepareDesktopState` and explicit `configure({ configPath })` calls. Pass `host: '127.0.0.1'`, the selected port, `mode: 'invert'`, and `profile: 'desktop'` to Origin. Persist the effective port. Memoize concurrent `start()` calls, reject with `redactDesktopError`, retain the error in `status()`, and make `stop()` idempotent. The status object may contain only booleans, port, URL, profile, import flags, and a redacted short error.

- [ ] **Step 4: Run lifecycle tests and commit the orchestrator**

Run:

```bash
node --test test/dao-desktop-runtime.test.js test/dao-desktop-paths.test.js test/dao-desktop-port.test.js
```

Expected: all tests PASS. Commit:

```bash
git add core/dao_desktop_runtime.js core/dao_desktop_paths.js core/dao_desktop_port.js test/dao-desktop-runtime.test.js
git diff --cached --check
git commit -m "feat: orchestrate the Dao Desktop runtime"
```

### Task 7: Wire a secure Electron window to the existing HUD

**Files:**
- Modify: `desktop/src/main/index.ts`, `desktop/src/preload/index.ts`, `desktop/src/renderer/src/main.ts`
- Create: `desktop/src/main/window-policy.ts`, `desktop/src/main/window-policy.test.ts`
- Create: `desktop/src/renderer/src/unavailable.html` or an equivalent DOM fallback module

- [ ] **Step 1: Write pure BrowserWindow policy tests**

Extract policy so it can run in Node without Electron:

```ts
import { describe, expect, it } from 'vitest'
import { secureWebPreferences, isAllowedNavigation } from './window-policy'

describe('Dao Desktop window policy', () => {
  it('disables Node in the renderer and enables isolation/sandbox', () => {
    expect(secureWebPreferences('/tmp/preload.js')).toMatchObject({
      preload: '/tmp/preload.js', nodeIntegration: false, contextIsolation: true, sandbox: true,
    })
  })
  it('allows only loopback HUD navigation and rejects external origins', () => {
    expect(isAllowedNavigation('http://127.0.0.1:8955/hud')).toBe(true)
    expect(isAllowedNavigation('https://example.com')).toBe(false)
    expect(isAllowedNavigation('file:///etc/passwd')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the policy test to verify failure**

Run: `npm --prefix desktop test -- --run src/main/window-policy.test.ts`

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Implement the policy and preload contract**

`window-policy.ts` must return `{ preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }`, accept only `http:`/`https:` loopback URLs, deny popup windows, and route explicit external links through `shell.openExternal` in main. The preload exposes only a read-only status/retry bridge:

```ts
contextBridge.exposeInMainWorld('daoDesktop', {
  getStatus: () => ipcRenderer.invoke('dao-desktop:status'),
  retry: () => ipcRenderer.invoke('dao-desktop:retry'),
})
```

Validate IPC channel names and return the sanitized status from main; never expose `fs`, `shell`, `process`, configuration paths, or credentials.

- [ ] **Step 4: Start the runtime before creating the window**

In `desktop/src/main/index.ts`, call `app.whenReady()`, instantiate `DaoDesktopRuntime` with `app.getPath('userData')`, await `start()`, create a `BrowserWindow` with the policy, install `will-navigate`/`setWindowOpenHandler` guards, and load `${status.url}/hud`. On startup failure, load a local diagnostic HTML page and make the retry IPC call `runtime.start()` again. On `before-quit`, prevent duplicate cleanup, await `runtime.stop()`, then allow quit. In development, no renderer URL may bypass the loopback allowlist.

- [ ] **Step 5: Verify typecheck/build and commit the shell**

Run:

```bash
npm --prefix desktop run typecheck
npm --prefix desktop run build
npm --prefix desktop test -- --run src/main/window-policy.test.ts
```

Expected: all commands exit 0 and the generated main bundle contains no renderer-side Node imports. Commit:

```bash
git add desktop
git diff --cached --check
git commit -m "feat: open Dao HUD in a secure Electron window"
```

### Task 8: Package runtime resources, add smoke coverage, and document macOS use

**Files:**
- Create: `desktop/electron-builder.yml`
- Create: `test/dao-desktop-package-layout.test.js`
- Create: `test/dao-desktop-smoke.test.js`
- Modify: `desktop/package.json`, `desktop/README.md`, `README.md`

- [ ] **Step 1: Define an explicit package resource map**

Configure `desktop/electron-builder.yml` so the app includes only the built Electron files and the runtime assets required by the existing relative `require()`/HUD paths:

```yaml
appId: com.daoflow.desktop
productName: Dao Flow
asar: true
extraResources:
  - from: ../core
    to: dao-runtime/core
  - from: ../vendor
    to: dao-runtime/vendor
  - from: ../ui
    to: dao-runtime/ui
  - from: ../media
    to: dao-runtime/media
mac:
  target:
    - dmg
  category: public.app-category.developer-tools
  identity: null
  arch:
    - arm64
```

Update the packaged-root resolver so `app.isPackaged` uses `process.resourcesPath/dao-runtime`, while development uses the repository root. Do not include `test/`, `docs/`, `.env`, legacy config, logs, or source maps in the packaged resource set.

- [ ] **Step 2: Add package-layout and smoke tests**

`test/dao-desktop-package-layout.test.js` must inspect the builder config and assert the four resource mappings plus absence of `test`, `docs`, and config filenames. `test/dao-desktop-smoke.test.js` must start a fixture runtime on an ephemeral loopback port, fetch `/hud` and `/origin/hud/snapshot`, assert HTTP 200 and the existing HUD marker, then stop and assert the port is released. Use an injected fake router or fixture config; never use real API keys.

- [ ] **Step 3: Add macOS developer and release instructions**

Document in `desktop/README.md`:

```bash
npm install
npm run dev
npm run build
npm run pack:mac
npm run dist:mac
```

State that Phase 1 is unsigned arm64 output, how to open the local HUD, where Desktop state is stored, how one-time migration behaves, and that no IDE settings/proxy/certificate are changed. Add a short root `README.md` section linking to the Desktop README and noting that VSIX and Desktop share route contracts but not live processes.

- [ ] **Step 4: Run the complete focused verification**

Run:

```bash
node --test test/dao-desktop-paths.test.js test/dao-desktop-port.test.js test/dao-desktop-config-injection.test.js test/dao-origin-lifecycle.test.js test/dao-desktop-runtime.test.js test/dao-desktop-package-layout.test.js test/dao-desktop-smoke.test.js
npm --prefix desktop run typecheck
npm --prefix desktop run build
npm test
```

Expected: all focused tests, Desktop build, and the existing VSIX suite pass; an occupied `8955` listener remains untouched. Fix only Phase 1 files if a regression appears, and rerun the focused test before the full suite.

- [ ] **Step 5: Review and commit the delivery slice**

Run:

```bash
git diff --check
git status --short
git add desktop core/dao_desktop_*.js test/dao-desktop-*.test.js test/dao-origin-lifecycle.test.js README.md
git diff --cached --check
git commit -m "feat: deliver Dao Desktop phase 1"
```

Confirm the commit contains no unrelated pre-existing files, then run `npm --prefix desktop run pack:mac` on Apple Silicon as the manual acceptance check. Signing, notarization, updater, host connectors, and the cc-haha-inspired session/command/activity console remain explicitly scoped to later phases.

## Plan self-review

- **Spec coverage:** runtime ownership and shutdown are Tasks 4–6; migration and secret handling are Task 2; loopback ports/API compatibility are Tasks 3, 5, and 6; Electron security and failure UI are Task 7; packaging and macOS acceptance are Task 8; cc-haha shell references are captured in the approved spec and reserved for Phase 2.
- **Reserved-marker scan:** searched this plan for unfinished-action markers and vague implementation phrases; none are used as an unfinished action. Every code change names an exact file, API shape, command, and expected result.
- **Type/contract consistency:** `resolveDesktopPaths` feeds `DaoDesktopRuntime`; `DaoDesktopRuntime.status().url` feeds the BrowserWindow loader; `profile: 'desktop'` is accepted by Origin and is tested independently; the preload status/retry channels match the main-process handlers.

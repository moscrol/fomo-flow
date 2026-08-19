# Dao React/Bun Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Dao Desktop's thin vanilla renderer with a cc-haha-style React/Vite/Bun Electron workspace while preserving the proven Dao-owned local runtime.

**Architecture:** `desktop/electron/` becomes the Bun-built Electron host and exposes a small typed capability bridge. `desktop/src/` becomes a React workspace that receives only sanitized runtime data and calls existing loopback contracts. Dao's CommonJS runtime remains packaged as an external resource and continues to own `/hud`, `/origin/*`, and `/v1/*`.

**Tech Stack:** Electron, React 18, React DOM, Vite, TypeScript, Vitest, Bun 1.3.14, electron-builder, existing Node/CommonJS Dao runtime.

---

## File map

| Path | Responsibility |
| --- | --- |
| `desktop/electron/main.ts` | Electron lifecycle, Dao runtime ownership, windows, menus, IPC registration |
| `desktop/electron/preload.ts` | Context-isolated typed desktop host bridge |
| `desktop/electron/ipc/channels.ts` | Fixed IPC channel names and event names |
| `desktop/electron/ipc/capabilities.ts` | Per-channel payload validation and caller-window gate |
| `desktop/electron/services/dao-runtime.ts` | Runtime root resolution and `DaoDesktopRuntime` facade |
| `desktop/scripts/electron-dev.ts` | Bun/Vite/Electron development launcher adapted from cc-haha under MIT notice |
| `desktop/src/main.tsx` | React root and global styles |
| `desktop/src/App.tsx` | Workspace composition and route/view state |
| `desktop/src/lib/desktopHost/*` | Renderer-safe host interface and Electron implementation |
| `desktop/src/lib/daoApi.ts` | Sanitized loopback API adapter |
| `desktop/src/components/*` | Shell, command palette, overview, HUD compatibility, capability views |
| `desktop/THIRD_PARTY_NOTICES.md` | MIT attribution for adapted cc-haha source/patterns |

Do not stage unrelated pre-existing changes. Before each commit, run `git diff --cached --check` on only the paths named in that commit.

### Task 1: Establish the Bun-first React/Vite Desktop package

**Files:**
- Modify: `desktop/package.json`, `desktop/tsconfig.json`, `desktop/electron-builder.yml`, `.gitignore`
- Create: `desktop/vite.config.ts`, `desktop/index.html`, `desktop/bunfig.toml`, `desktop/THIRD_PARTY_NOTICES.md`
- Remove after migration: `desktop/electron.vite.config.ts`, `desktop/src/main/index.ts`, `desktop/src/preload/index.ts`, `desktop/src/renderer/*`
- Test: `desktop/src/lib/desktopHost/types.test.ts`

- [ ] **Step 1: Add the failing host-contract test**

Create `desktop/src/lib/desktopHost/types.test.ts` with the narrow renderer contract:

```ts
import { describe, expect, it } from 'vitest'
import { isDaoDesktopStatus } from './types'

describe('Dao desktop host status contract', () => {
  it('accepts only the redacted runtime status shape', () => {
    expect(isDaoDesktopStatus({
      healthy: true, running: true, port: 8955, url: 'http://127.0.0.1:8955',
      profile: 'desktop', imported: { config: false, revproxy: true }, error: null,
    })).toBe(true)
    expect(isDaoDesktopStatus({ healthy: true, apiKey: 'secret' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run the new test and confirm the missing-contract failure**

Run: `npm --prefix desktop run test -- --run src/lib/desktopHost/types.test.ts`

Expected: FAIL because `desktop/src/lib/desktopHost/types.ts` does not exist.

- [ ] **Step 3: Install the pinned local build toolchain and React renderer dependencies**

Use project-local dependencies only:

```bash
npm --prefix desktop install react@18.3.1 react-dom@18.3.1
npm --prefix desktop install -D bun@1.3.14 @vitejs/plugin-react@latest @types/react@18 @types/react-dom@18
```

Set the package metadata and scripts to the cc-haha-shaped workflow:

```json
{
  "type": "module",
  "main": "electron-dist/main.cjs",
  "packageManager": "bun@1.3.14",
  "scripts": {
    "dev": "bun run electron:dev",
    "build": "vite build",
    "build:electron": "bun build ./electron/main.ts --outfile ./electron-dist/main.cjs --target node --format cjs --external electron && bun build ./electron/preload.ts --outfile ./electron-dist/preload.cjs --target node --format cjs --external electron",
    "electron:dev": "bun run build:electron && bun run ./scripts/electron-dev.ts",
    "electron:package:dir": "bun run build && bun run build:electron && electron-builder --dir --publish never",
    "test": "vitest run"
  }
}
```

Keep `npm` scripts as explicit fallback aliases until the local Bun binary and `bun install` are verified. Add `desktop/electron-dist/`, `desktop/.bun/`, and Bun's local cache directory to `.gitignore`; do not ignore `bun.lock`.

- [ ] **Step 4: Implement the renderer-safe runtime status contract**

Create `desktop/src/lib/desktopHost/types.ts`:

```ts
export type DaoDesktopStatus = {
  healthy: boolean
  running: boolean
  port: number | null
  url: string | null
  profile: 'desktop'
  imported: { config: boolean; revproxy: boolean }
  error: string | null
}

export function isDaoDesktopStatus(value: unknown): value is DaoDesktopStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value as Record<string, unknown>
  return typeof status.healthy === 'boolean' && typeof status.running === 'boolean' &&
    (typeof status.port === 'number' || status.port === null) &&
    (typeof status.url === 'string' || status.url === null) &&
    status.profile === 'desktop' && !!status.imported && typeof status.error !== 'undefined'
}
```

Add `desktop/vite.config.ts` with `@vitejs/plugin-react`, `base: './'`, `src` alias, and `build.target: 'es2021'`. Add `desktop/index.html` containing `<div id="root"></div><script type="module" src="/src/main.tsx"></script>`. Add `desktop/bunfig.toml` with `saveTextLockfile = false` and an attribution notice naming cc-haha's MIT license.

- [ ] **Step 5: Verify React/Vite and the local Bun binary**

Run:

```bash
npm --prefix desktop exec -- bun --version
npm --prefix desktop run test -- --run src/lib/desktopHost/types.test.ts
npm --prefix desktop run build
```

Expected: Bun reports `1.3.14`, the status-contract test passes, and Vite produces `desktop/dist/`.

- [ ] **Step 6: Commit the independent foundation**

```bash
git add desktop/package.json desktop/package-lock.json desktop/bun.lock desktop/bunfig.toml desktop/vite.config.ts desktop/index.html desktop/src/lib/desktopHost/types.ts desktop/src/lib/desktopHost/types.test.ts desktop/THIRD_PARTY_NOTICES.md .gitignore
git diff --cached --check
git commit -m "build: adopt Dao React Bun desktop foundation"
```

### Task 2: Move Electron ownership into cc-haha-style focused modules

**Files:**
- Create: `desktop/electron/main.ts`, `desktop/electron/preload.ts`, `desktop/electron/ipc/channels.ts`, `desktop/electron/ipc/capabilities.ts`, `desktop/electron/services/dao-runtime.ts`, `desktop/electron/services/navigation.ts`, `desktop/scripts/electron-dev.ts`
- Modify: `desktop/electron-builder.yml`
- Test: `desktop/electron/ipc/capabilities.test.ts`, `desktop/electron/services/dao-runtime.test.ts`, `desktop/electron/services/navigation.test.ts`

- [ ] **Step 1: Write failing capability and navigation tests**

```ts
expect(validateDesktopIpcPayload('dao:runtime-status', undefined)).toBe(true)
expect(validateDesktopIpcPayload('dao:open-external', { url: 'https://example.com' })).toBe(true)
expect(validateDesktopIpcPayload('dao:open-external', { url: 'file:///etc/passwd' })).toBe(false)
expect(isAllowedMainNavigation('http://127.0.0.1:8955/hud')).toBe(true)
expect(isAllowedMainNavigation('https://example.com')).toBe(false)
```

Run: `npm --prefix desktop run test -- --run electron/ipc/capabilities.test.ts electron/services/navigation.test.ts`

Expected: FAIL because the new Electron modules do not exist.

- [ ] **Step 2: Define fixed channels and validation**

Create a string-literal channel map:

```ts
export const ELECTRON_IPC_CHANNELS = {
  runtimeStatus: 'dao:runtime-status',
  runtimeRetry: 'dao:runtime-retry',
  shellOpenExternal: 'dao:open-external',
  shellOpenConfig: 'dao:open-config',
  clipboardWrite: 'dao:clipboard-write',
} as const
```

`validateDesktopIpcPayload` accepts no payload for status/retry/open-config, a
bounded `http:` or `https:` URL for external opening, and at most one megabyte
of text for clipboard writes. It rejects unknown channels and all filesystem or
arbitrary-command messages.

- [ ] **Step 3: Extract the existing runtime facade without changing its contract**

`desktop/electron/services/dao-runtime.ts` resolves the dev/package resource
root, lazily requires `core/dao_desktop_runtime.js`, and exposes only:

```ts
export type DaoRuntimeFacade = {
  start(): Promise<DaoDesktopStatus>
  status(): DaoDesktopStatus
  stop(): Promise<void>
}
```

Test that development resolves the repository root, packaged mode resolves
`process.resourcesPath/dao-runtime`, and the runtime constructor receives
`app.getPath('userData')`.

- [ ] **Step 4: Implement the Electron main and preload bridge**

`electron/main.ts` must acquire the single instance lock, start the runtime
before revealing the main window, load the Vite server in development or
`dist/index.html` when packaged, and await `stop()` in `before-quit`.

Use these renderer preferences exactly:

```ts
webPreferences: {
  preload: preloadPath(),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}
```

`electron/preload.ts` exposes `window.desktopHost` with only typed `invoke`
and `subscribe` methods backed by the channel map.  The main process validates
payloads before dispatch and verifies that the caller is the main window.

Adapt `scripts/electron-dev.ts` from cc-haha's MIT-licensed launcher, retaining
the source attribution header. It starts Vite on port 1420, sets `NO_PROXY` for
loopback hosts, waits for the renderer, then launches Electron with the compiled
main bundle.

- [ ] **Step 5: Configure packaging resources and run focused tests**

Keep these resources out of `app.asar` in `electron-builder.yml`:

```yaml
extraResources:
  - from: ../core
    to: dao-runtime/core
  - from: ../vendor
    to: dao-runtime/vendor
  - from: ../ui
    to: dao-runtime/ui
  - from: ../media
    to: dao-runtime/media
  - from: ../package.json
    to: dao-runtime/package.json
```

Run:

```bash
npm --prefix desktop run test -- --run electron/ipc/capabilities.test.ts electron/services/dao-runtime.test.ts electron/services/navigation.test.ts
npm --prefix desktop exec -- bun run build:electron
```

Expected: all tests pass and `desktop/electron-dist/main.cjs` plus
`preload.cjs` exist.

- [ ] **Step 6: Commit the host migration**

```bash
git add desktop/electron desktop/scripts/electron-dev.ts desktop/electron-builder.yml
git diff --cached --check
git commit -m "feat: add Dao Bun Electron host boundary"
```

### Task 3: Build the React workspace shell and command surface

**Files:**
- Create: `desktop/src/main.tsx`, `desktop/src/App.tsx`, `desktop/src/theme/globals.css`, `desktop/src/components/WorkspaceShell.tsx`, `desktop/src/components/Sidebar.tsx`, `desktop/src/components/CommandPalette.tsx`, `desktop/src/components/ViewPlaceholder.tsx`
- Create: `desktop/src/lib/desktopHost/electronHost.ts`, `desktop/src/lib/desktopHost/index.ts`
- Test: `desktop/src/App.test.tsx`, `desktop/src/components/CommandPalette.test.tsx`

- [ ] **Step 1: Add component tests before rendering implementation**

```tsx
render(<App initialView="overview" />)
expect(screen.getByRole('heading', { name: 'Dao Flow' })).toBeInTheDocument()
expect(screen.getByRole('button', { name: '总览' })).toHaveAttribute('aria-current', 'page')

render(<CommandPalette open views={views} onSelect={onSelect} onClose={onClose} />)
await user.type(screen.getByPlaceholderText('搜索命令或视图'), '反代')
expect(screen.getByRole('option', { name: /反向代理/ })).toBeVisible()
```

Run: `npm --prefix desktop run test -- --run src/App.test.tsx src/components/CommandPalette.test.tsx`

Expected: FAIL because the React workspace modules do not exist.

- [ ] **Step 2: Implement the renderer host client**

Create `desktop/src/lib/desktopHost/electronHost.ts` to call only the typed
channel constants. It validates status with `isDaoDesktopStatus` before
returning it to React. `desktop/src/lib/desktopHost/index.ts` supplies a
browser-safe unavailable host for unit tests, so no component reads Electron
globals directly.

- [ ] **Step 3: Implement the shell and keyboard access**

Define these view IDs:

```ts
export const DAO_VIEWS = ['overview', 'hud', 'providers', 'routes', 'revproxy', 'observability', 'connectors'] as const
```

The sidebar renders each view by a descriptive Chinese label. The main pane has
an `h1` for the active view. `Cmd+K`/`Ctrl+K` opens the dialog, Escape closes
it, ArrowUp/ArrowDown moves an active option, and Enter selects the active
view. Persist only sidebar width and last selected view in renderer
`localStorage`; no runtime state or credentials enter browser storage.

`globals.css` follows the cc-haha workspace direction: dark ink backdrop,
resizable muted sidebar, high-contrast activity states, system font stack, and
visible focus outlines. It uses original Dao styles rather than copied branded
artwork.

- [ ] **Step 4: Implement all initial view slots**

`ViewPlaceholder.tsx` gives Providers, Routes, Reverse Proxy, Observability,
and Connectors a clear title, scope statement, and safe status banner. The
Connectors slot must say “未配置” and explain that opening Dao does not modify
Codex or IDE settings. The HUD slot contains a controlled `iframe` pointing to
`http://127.0.0.1:<port>/hud` only when the validated status is healthy; it
renders a redacted retry state otherwise.

- [ ] **Step 5: Verify React behavior and production build**

Run:

```bash
npm --prefix desktop run test -- --run src/App.test.tsx src/components/CommandPalette.test.tsx
npm --prefix desktop run build
npm --prefix desktop exec -- bun run build:electron
```

Expected: component tests pass; Vite and Electron bundles build without the
renderer importing Node, `fs`, `child_process`, or raw configuration paths.

- [ ] **Step 6: Commit the workspace shell**

```bash
git add desktop/src desktop/index.html desktop/vite.config.ts
git diff --cached --check
git commit -m "feat: add Dao React workspace shell"
```

### Task 4: Attach sanitized Dao runtime data to the Overview and HUD views

**Files:**
- Create: `desktop/src/lib/daoApi.ts`, `desktop/src/lib/daoApi.test.ts`, `desktop/src/components/OverviewView.tsx`, `desktop/src/components/OverviewView.test.tsx`, `desktop/src/components/HudView.tsx`
- Modify: `desktop/src/App.tsx`

- [ ] **Step 1: Write failing API-adapter and overview tests**

```ts
const result = await getDaoOverview({ fetchImpl })
expect(result).toEqual({ providers: 2, routes: 3, sessions: 4, alerts: 0 })
expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8955/origin/hud/snapshot', expect.any(Object))
```

```tsx
render(<OverviewView status={healthyStatus} overview={{ providers: 2, routes: 3, sessions: 4, alerts: 0 }} />)
expect(screen.getByText('2')).toBeVisible()
expect(screen.queryByText(/apiKey|secret/i)).not.toBeInTheDocument()
```

Run: `npm --prefix desktop run test -- --run src/lib/daoApi.test.ts src/components/OverviewView.test.tsx`

Expected: FAIL because the adapter and overview component do not exist.

- [ ] **Step 2: Implement a bounded loopback-only API adapter**

`daoApi.ts` accepts a validated `DaoDesktopStatus`, constructs its base URL
from `status.url`, and refuses any non-loopback origin. It requests
`/origin/hud/snapshot` and `/origin/ea/overview` with `cache: 'no-store'`.
It projects only numeric counts, booleans, short labels, and redacted health
states. It drops `apiKey`, `apiKeys`, `authorization`, `prompt`, `raw`, and
unknown fields before returning React data.

- [ ] **Step 3: Implement polling and visible failure states**

`OverviewView` polls every five seconds only while visible, clears timers on
unmount, and distinguishes `运行中`, `启动中`, and `需要重试` without displaying
raw errors. `HudView` is the existing HUD compatibility iframe and must set a
descriptive title, no-referrer policy, and a sandbox that excludes scripts
outside its own loopback origin.

- [ ] **Step 4: Run focused and existing regression tests**

Run:

```bash
npm --prefix desktop run test -- --run src/lib/daoApi.test.ts src/components/OverviewView.test.tsx src/App.test.tsx
node test/web-hud-http.test.js
node test/web-hud-service.test.js
node --test test/dao-desktop-paths.test.js test/dao-desktop-port.test.js test/dao-desktop-runtime.test.js test/dao-desktop-smoke.test.js
```

Expected: React data is redacted, existing HUD contracts still pass, and
Desktop runtime starts/stops correctly.

- [ ] **Step 5: Commit the first attached Dao capabilities**

```bash
git add desktop/src/lib/daoApi.ts desktop/src/lib/daoApi.test.ts desktop/src/components/OverviewView.tsx desktop/src/components/OverviewView.test.tsx desktop/src/components/HudView.tsx desktop/src/App.tsx
git diff --cached --check
git commit -m "feat: attach Dao runtime overview to workspace"
```

### Task 5: Package and isolated macOS acceptance

**Files:**
- Modify: `desktop/README.md`
- Test: `test/dao-desktop-package-layout.test.js`, `test/dao-desktop-smoke.test.js`

- [ ] **Step 1: Update the Desktop operator guide**

Document:

```text
bun install
bun run dev
bun run electron:package:dir
```

Also document the npm fallback, local configuration root, default loopback
endpoint behavior, unsigned macOS build limitation, and cc-haha MIT notice.

- [ ] **Step 2: Build the application**

Run:

```bash
npm --prefix desktop exec -- bun run electron:package:dir
```

Expected: `desktop/dist/mac-arm64/Dao Flow.app` contains React assets,
`electron-dist/main.cjs`, `preload.cjs`, and `dao-runtime/{core,vendor,ui,media}`.

- [ ] **Step 3: Run an isolated launch smoke**

Launch the packaged app with a temporary `HOME` and user-data path. Verify:

1. `/hud` returns HTTP 200 on a loopback-only port.
2. The React main window loads the Overview shell.
3. The HUD view loads only the resolved local URL.
4. No legacy config bytes are modified.
5. After quit, no Dao Flow listener remains.

- [ ] **Step 4: Run final validation**

Run:

```bash
npm --prefix desktop run test -- --run
npm --prefix desktop run build
node test/swe-route-guard.test.js
node test/web-hud-http.test.js
node test/web-hud-service.test.js
node --test test/dao-desktop-paths.test.js test/dao-desktop-port.test.js test/dao-desktop-config-injection.test.js test/dao-origin-lifecycle.test.js test/dao-desktop-runtime.test.js test/dao-desktop-package-layout.test.js test/dao-desktop-smoke.test.js
```

Expected: all Desktop/Routing/HUD focused tests pass. If the repository-wide
suite has a pre-existing unrelated failure, record the exact failing assertion
and leave the unrelated worktree change untouched.

- [ ] **Step 5: Commit packaging and docs**

```bash
git add desktop/README.md test/dao-desktop-package-layout.test.js test/dao-desktop-smoke.test.js
git diff --cached --check
git commit -m "build: package Dao React desktop workspace"
```

## Plan self-review

- **Spec coverage:** Tasks 1–3 implement the React/Vite/Bun workspace and
  cc-haha-style Electron boundary; Task 4 attaches real Dao capabilities; Task
  5 validates runtime ownership, local-only traffic, attribution, packaging,
  and macOS launch.
- **Scope:** host connectors remain a later independent phase, as required by
  the approved design. No Claude-specific cc-haha server code is imported.
- **Consistency:** all renderer state uses `DaoDesktopStatus`, the fixed IPC
  channel map, or the loopback `daoApi` adapter; none reads config files.

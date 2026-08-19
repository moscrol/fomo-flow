# Dao Flow Pluginless Devin ACP Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Dao Flow Desktop create and manage one new local Devin ACP session without modifying or depending on the Dao Flow Devin plugin.

**Architecture:** Electron main owns the Devin process, workspace path, ACP IDs, permission promises, and sanitized bounded snapshot. A narrow typed IPC surface exposes only opaque handles and safe events to a new React view. The official stable ACP v1 SDK connects to the existing Dao stdio proxy, so session model selection remains per-session and the configured global route priority is never written.

**Tech Stack:** Electron 39, React 18, TypeScript 5.9, Bun main-process bundling, `@agentclientprotocol/sdk@1.3.0`, Zod peer runtime, Vitest, electron-builder.

---

## File map

- `desktop/electron/services/devin-acp-resources.ts`: resolve allowlisted Devin and packaged proxy paths.
- `desktop/electron/services/devin-acp-projection.ts`: convert ACP updates and permissions to bounded safe renderer data.
- `desktop/electron/services/devin-acp-adapter.ts`: own ACP SDK stream, handshake, session and prompt calls.
- `desktop/electron/services/devin-acp-host.ts`: one-session process/state/permission/workspace lifecycle.
- `desktop/src/lib/desktopHost/devinAcpHost.ts`: shared renderer-safe contracts and runtime validators.
- `desktop/electron/ipc/channels.ts`, `capabilities.ts`: exact host channels and payload allowlists.
- `desktop/electron/preload.ts`, `main.ts`: narrow bridge and service wiring.
- `desktop/src/components/control/DevinConnectControlView.tsx`: beginner-facing local ACP host view.
- `desktop/src/lib/views.ts`, `desktop/src/App.tsx`, `desktop/src/components/Sidebar.tsx`: navigation integration.
- `desktop/electron-builder.yml`: package proxy and its local dependencies.
- `desktop/electron/services/fixtures/fake-devin-acp-agent.mjs`: deterministic child-process ACP fixture that resolves the Desktop-owned SDK dependency.
- Existing README/parity docs: capability and boundary record.

### Task 1: Pin ACP SDK and package resource resolver

**Files:**

- Modify: `desktop/package.json`
- Modify: `desktop/package-lock.json`
- Create: `desktop/electron/services/devin-acp-resources.ts`
- Create: `desktop/electron/services/devin-acp-resources.test.ts`
- Modify: `desktop/electron-builder.yml`

- [x] **Step 1: Write failing resolver tests**

Cover development and packaged roots, exact macOS Devin allowlist, missing file, and refusal to accept an injected renderer path:

```ts
expect(
  resolveDevinAcpResources({
    isPackaged: false,
    appPath: "/repo/desktop",
    resourcesPath: "/Applications/Dao Flow.app/Contents/Resources",
    exists: (path) => present.has(path),
  }),
).toEqual({
  available: true,
  devinPath: DEVIN_MAC_ACP_PATH,
  proxyPath: "/repo/dao-acp-stdio-proxy.js",
});

expect(
  resolveDevinAcpResources({
    isPackaged: true,
    appPath: "/Applications/Dao Flow.app/Contents/Resources/app.asar",
    resourcesPath: "/Applications/Dao Flow.app/Contents/Resources",
    exists: () => false,
  }),
).toEqual({ available: false, reason: "devin_missing" });
```

- [x] **Step 2: Run the test and verify RED**

Run: `cd desktop && npm test -- --run electron/services/devin-acp-resources.test.ts`

Expected: FAIL because `devin-acp-resources.ts` does not exist.

- [x] **Step 3: Install exact stable SDK runtime**

Run: `cd desktop && npm install --save-exact @agentclientprotocol/sdk@1.3.0 zod@4.0.17`

Expected: `package.json` and lockfile contain exact versions; no experimental v2 import is added.

- [x] **Step 4: Implement the pure resolver**

```ts
export const DEVIN_MAC_ACP_PATH =
  "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin";

export function resolveDevinAcpResources(input: ResourceInput): ResourceResult {
  const proxyPath = input.isPackaged
    ? join(input.resourcesPath, "dao-acp-host", "dao-acp-stdio-proxy.js")
    : resolve(input.appPath, "..", "dao-acp-stdio-proxy.js");
  if (!input.exists(DEVIN_MAC_ACP_PATH))
    return { available: false, reason: "devin_missing" };
  if (!input.exists(proxyPath))
    return { available: false, reason: "proxy_missing" };
  return { available: true, devinPath: DEVIN_MAC_ACP_PATH, proxyPath };
}
```

Add `extraResources` entries for the proxy and exactly its four local dependencies under `dao-acp-host/`, preserving their relative paths.

- [x] **Step 5: Verify GREEN and package config**

Run: `cd desktop && npm test -- --run electron/services/devin-acp-resources.test.ts && npm run typecheck`

Expected: resolver tests and typecheck pass.

### Task 2: Define safe host contract and ACP projection

**Files:**

- Create: `desktop/src/lib/desktopHost/devinAcpHost.ts`
- Create: `desktop/electron/services/devin-acp-projection.ts`
- Create: `desktop/electron/services/devin-acp-projection.test.ts`
- Modify: `desktop/src/lib/desktopHost/index.ts`

- [x] **Step 1: Write failing privacy and bounds tests**

Use fixtures containing a prompt echo, `Authorization: AWS4...`, `/Users/a77/private`, a shell command, raw ACP session/tool IDs, 70 KiB text, and 250 updates. Assert that the projection has at most 200 events and contains none of those values.

```ts
const event = projectAcpUpdate(rawUpdate, 1_700_000_000_000);
expect(JSON.stringify(event)).not.toContain("/Users/a77");
expect(JSON.stringify(event)).not.toContain("session-raw-1");
expect(JSON.stringify(event)).not.toContain("rm -rf");
expect(event?.message.length).toBeLessThanOrEqual(2_000);
```

- [x] **Step 2: Run the test and verify RED**

Run: `cd desktop && npm test -- --run electron/services/devin-acp-projection.test.ts`

Expected: FAIL because contracts and projection do not exist.

- [x] **Step 3: Implement shared renderer-safe types**

Define `DevinHostPhase`, `DevinHostModelOption`, `DevinHostEvent`, `DevinHostPermission`, and `DevinHostSnapshot`. The snapshot contains only:

```ts
export type DevinHostSnapshot = {
  phase: DevinHostPhase;
  runtimeHealthy: boolean;
  devinAvailable: boolean;
  workspace?: { handle: string; label: string };
  models: DevinHostModelOption[];
  selectedModel: string;
  events: DevinHostEvent[];
  permission?: DevinHostPermission;
  droppedEventCount: number;
  error?: { code: DevinHostErrorCode; message: string };
};
```

Add runtime guards that reject unknown keys and overlong strings before accepting a main-process response.

- [x] **Step 4: Implement safe projections**

Reuse `sanitizeDisplayText`. Map only ACP text chunks, plans, tool call status, config option updates, usage summaries and safe errors. Tool calls become fixed categories (`读取文件`, `修改文件`, `运行本地命令`, `使用工具`) without input payloads or locations. Model options accept only bounded `configId === 'model'` select values. Permission options retain only `allow_once` and reject variants; never surface `allow_always`.

- [x] **Step 5: Verify GREEN**

Run: `cd desktop && npm test -- --run electron/services/devin-acp-projection.test.ts && npm run typecheck`

Expected: all projection privacy, bounds, alias and malformed-payload tests pass.

### Task 3: Build the ACP adapter against a deterministic child

**Files:**

- Create: `desktop/electron/services/devin-acp-adapter.ts`
- Create: `desktop/electron/services/devin-acp-adapter.test.ts`
- Create: `desktop/electron/services/fixtures/fake-devin-acp-agent.mjs`

- [x] **Step 1: Write failing adapter integration tests**

Spawn the fake child and assert initialize → newSession → optional model config → prompt. The fake agent emits an agent message, a tool call, a permission request, and an end-turn result. Add cancel and protocol-error cases.

```ts
const adapter = createDevinAcpAdapter({ child, onUpdate, onPermission });
const session = await adapter.start("/tmp/acp-safe-workspace");
expect(session.models.map((model) => model.value)).toContain("dao-gpt-5-6-sol");
await adapter.selectModel("dao-gpt-5-6-sol");
await adapter.prompt("fixture prompt");
expect(onUpdate).toHaveBeenCalledWith(
  expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
);
```

- [x] **Step 2: Run the integration test and verify RED**

Run: `cd desktop && npm test -- --run electron/services/devin-acp-adapter.test.ts`

Expected: FAIL because the adapter and fixture are absent.

- [x] **Step 3: Implement the fake ACP agent**

Use `@agentclientprotocol/sdk` `agent({ name: 'dao-test-agent' })` and `ndJsonStream`. Return protocol v1, one model config option, and a deterministic `sessionId`. The permission branch must await the client response and record whether `allow_once` or rejection was selected.

- [x] **Step 4: Implement the SDK adapter**

Convert Node child stdout/stdin with `Readable.toWeb` and `Writable.toWeb`, then use:

```ts
const app = client({ name: "Dao Flow", version: appVersion })
  .onNotification(methods.client.session.update, ({ params }) =>
    onUpdate(params),
  )
  .onRequest(methods.client.session.requestPermission, ({ params }) =>
    onPermission(params),
  );

connectionTask = app.connectWith(ndJsonStream(output, input), async (agent) => {
  context = agent;
  await agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { session: { configOptions: {} } },
    clientInfo: { name: "Dao Flow", version: appVersion },
  });
  const created = await agent.request(methods.agent.session.new, {
    cwd,
    mcpServers: [],
  });
  sessionId = created.sessionId;
  ready.resolve(projectSession(created));
  await lifetime.promise;
});
```

Keep the context alive until `stop`; never log request bodies or raw frames.

- [x] **Step 5: Verify GREEN and cancellation semantics**

Run: `cd desktop && npm test -- --run electron/services/devin-acp-adapter.test.ts`

Expected: handshake, prompt, permission, cancel, child exit and malformed protocol tests pass without leaked child processes.

### Task 4: Implement one-session host lifecycle

**Files:**

- Create: `desktop/electron/services/devin-acp-host.ts`
- Create: `desktop/electron/services/devin-acp-host.test.ts`

- [x] **Step 1: Write failing host state-machine tests**

Cover unavailable/runtime-offline/ready/starting/connected/running/waiting_permission/stopped/failed, opaque workspace handles, one-session enforcement, stale permission rejection, 200-event truncation, renderer snapshot recovery, and shutdown timeout.

```ts
const workspace = await host.chooseWorkspace();
expect(workspace).toMatchObject({ label: "fixture-workspace" });
expect(JSON.stringify(workspace)).not.toContain("/tmp/");
await host.start({ workspaceHandle: workspace.handle });
await expect(host.start({ workspaceHandle: workspace.handle })).rejects.toThrow(
  "已有 Devin 会话",
);
```

- [x] **Step 2: Run the host test and verify RED**

Run: `cd desktop && npm test -- --run electron/services/devin-acp-host.test.ts`

Expected: FAIL because the host service is absent.

- [x] **Step 3: Implement process and workspace ownership**

Inject `spawn`, resource resolver, runtime health, directory picker, clock and random ID factories for tests. Store the real directory in a main-only `Map<handle, path>`. Spawn only the resolved proxy and Devin executable; remove `ELECTRON_RUN_AS_NODE` ambiguity by setting it for the Node proxy child, and pass the selected Desktop endpoint through the existing main-only environment contract.

- [x] **Step 4: Implement state, permission and shutdown rules**

Only `connected` accepts prompt; only `running` accepts cancel; only the current pending local permission ID accepts allow-once/reject. `stop()` rejects pending permission, sends cancel when needed, closes the adapter, sends SIGTERM, waits at most 2 seconds, then SIGKILLs the exact child PID. App shutdown calls the same idempotent method.

- [x] **Step 5: Verify GREEN**

Run: `cd desktop && npm test -- --run electron/services/devin-acp-host.test.ts && npm run typecheck`

Expected: state, privacy, idempotency and cleanup tests pass.

### Task 5: Add strict IPC and preload bridge

**Files:**

- Modify: `desktop/electron/ipc/channels.ts`
- Modify: `desktop/electron/ipc/capabilities.ts`
- Modify: `desktop/electron/ipc/capabilities.test.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/src/lib/desktopHost/index.ts`

- [x] **Step 1: Write failing payload allowlist tests**

Assert exact valid shapes and reject extra keys, absolute paths, commands, env, overlong prompt, unknown permission decisions, raw IDs and non-empty status/choose/cancel/stop payloads.

```ts
expect(
  validateDesktopIpcPayload("dao:devin-host-start", {
    workspaceHandle: validHandle,
  }),
).toBe(true);
expect(
  validateDesktopIpcPayload("dao:devin-host-start", {
    workspaceHandle: validHandle,
    command: "/bin/sh",
  }),
).toBe(false);
expect(
  validateDesktopIpcPayload("dao:devin-host-prompt", {
    prompt: "x".repeat(65_537),
  }),
).toBe(false);
```

- [x] **Step 2: Run and verify RED**

Run: `cd desktop && npm test -- --run electron/ipc/capabilities.test.ts`

Expected: new channels are unknown and tests fail.

- [x] **Step 3: Implement exact channels and handlers**

Add handlers for status, choose, start, prompt, permission, cancel and stop. Add a one-way event sender only to the live trusted main window. Register a disposer so renderer reload does not accumulate listeners. In `before-quit`, await `devinHost.stop()` before `daoRuntime.stop()` and then quit.

- [x] **Step 4: Expose typed preload methods**

```ts
getDevinHostStatus: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostStatus),
chooseDevinWorkspace: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostChooseWorkspace),
startDevinHost: (workspaceHandle: string) => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostStart, { workspaceHandle }),
promptDevinHost: (prompt: string, model?: string) => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostPrompt, { prompt, ...(model ? { model } : {}) }),
respondDevinPermission: (permissionId: string, decision: 'allow_once' | 'reject') => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostPermission, { permissionId, decision }),
cancelDevinHost: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostCancel),
stopDevinHost: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostStop),
subscribeDevinHost: (listener) => {
  const handler = (_event, snapshot) => listener(snapshot)
  ipcRenderer.on(ELECTRON_IPC_CHANNELS.devinHostEvent, handler)
  return () => ipcRenderer.removeListener(ELECTRON_IPC_CHANNELS.devinHostEvent, handler)
}
```

- [x] **Step 5: Verify IPC and type safety**

Run: `cd desktop && npm test -- --run electron/ipc/capabilities.test.ts && npm run typecheck`

Expected: strict allowlist and typecheck pass.

### Task 6: Build the beginner-facing Devin connection view

**Files:**

- Create: `desktop/src/components/control/DevinConnectControlView.tsx`
- Create: `desktop/src/components/control/DevinConnectControlView.test.tsx`
- Modify: `desktop/src/lib/views.ts`
- Modify: `desktop/src/lib/views.test.ts`
- Modify: `desktop/src/components/Sidebar.tsx`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/App.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write failing React and navigation tests**

Cover missing Devin, runtime offline, directory label without full path, explicit connect, model select only after connected, prompt send, streamed events, manual allow/reject, cancel, stop, reconnect, keyboard focus, and no raw IDs/commands/path in DOM. Assert clicking no control automatically calls start/prompt/permission/model selection.

- [x] **Step 2: Run and verify RED**

Run: `cd desktop && npm test -- --run src/components/control/DevinConnectControlView.test.tsx src/App.test.tsx src/lib/views.test.ts`

Expected: view and `devinConnect` navigation ID are absent.

- [x] **Step 3: Implement conclusion-first UI**

Render four bounded sections: “能否连接”, “选择工作目录”, “发送任务”, “会话进展”. Use native buttons/select/textarea with labels. Hide the model select before the server returns options. Permission cards contain only “允许一次” and “拒绝”. Disable prompt while running or waiting for permission. Do not render technical ACP IDs or raw JSON.

- [x] **Step 4: Integrate navigation**

Add `devinConnect` to the collaboration group immediately before `collaboration`, use label `Devin 接入`, and add an explicit icon mapping. Lazy-render the view in `App.tsx`; keep all existing view IDs and order otherwise intact.

- [x] **Step 5: Add scoped responsive styles and verify GREEN**

Use `.devin-connect-*` selectors and existing theme tokens only. Run:

`cd desktop && npm test -- --run src/components/control/DevinConnectControlView.test.tsx src/App.test.tsx src/lib/views.test.ts && npm run typecheck && npx eslint --quiet src/components/control/DevinConnectControlView.tsx src/lib/views.ts src/App.tsx`

Expected: focused tests, typecheck and lint pass.

### Task 7: Feed safe hosted-session facts into existing observation

**Files:**

- Modify: `desktop/electron/services/devin-acp-host.ts`
- Modify: `desktop/electron/services/dao-observation-source.ts`
- Modify: `desktop/electron/services/dao-observation-source.test.ts`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/src/components/work/workItemModel.test.ts`

- [x] **Step 1: Write failing observation tests**

Inject a hosted safe session and assert source `devin-host`, model label, active phase and fingerprint appear without workspace path, prompt or raw ACP session ID. Advance the clock past five minutes and assert it leaves current work without invoking host stop.

- [x] **Step 2: Run and verify RED**

Run: `cd desktop && npm test -- --run electron/services/dao-observation-source.test.ts src/components/work/workItemModel.test.ts`

Expected: hosted session is not yet part of observation.

- [x] **Step 3: Add a narrow safe-session provider**

Expose `host.observationSession()` returning only a hashed fingerprint, source, safe workspace label, selected model label, lifecycle, last activity time and warning. Inject it into `createDaoObservationSource`; merge it after normal source selection without changing source scoring or configured route priority.

- [x] **Step 4: Preserve five-minute display retirement**

Reuse the existing work lifecycle projection. Do not call `host.stop()` from retirement logic. Add an explicit test spying on `stop` to keep display lifecycle separate from process lifecycle.

- [x] **Step 5: Verify GREEN**

Run: `cd desktop && npm test -- --run electron/services/dao-observation-source.test.ts src/components/work/workItemModel.test.ts`

Expected: safe hosted session appears while fresh, retires after five minutes, and the child remains controlled only by explicit lifecycle methods.

### Task 8: Documentation, full verification, package and real-app smoke

**Files:**

- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`
- Modify: `desktop/THIRD_PARTY_NOTICES.md`
- Modify: `docs/superpowers/plans/2026-08-11-dao-pluginless-devin-acp-host.md`

- [x] **Step 1: Document the capability and hard boundaries**

Record that Dao Flow can host new Devin ACP sessions without the plugin, cannot capture existing native Devin chats, never changes global priority, does not retain prompt/path/Auth/raw IDs, and does not modify the plugin. Add Apache-2.0 SDK attribution.

- [x] **Step 2: Run focused and full quality gates**

Run:

```bash
cd desktop
npm test -- --run electron/services/devin-acp-resources.test.ts electron/services/devin-acp-projection.test.ts electron/services/devin-acp-adapter.test.ts electron/services/devin-acp-host.test.ts electron/ipc/capabilities.test.ts src/components/control/DevinConnectControlView.test.tsx
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit 0; no snapshot includes forbidden values.

- [x] **Step 3: Run root proxy regressions**

Run: `node test/acp-stdio-proxy.test.js && node test/acp-workspace-message.test.js && node test/dao-local-endpoint.test.js`

Expected: existing plugin/proxy and endpoint behavior remain green.

- [x] **Step 4: Package macOS and verify resources**

Run: `cd desktop && npm run pack:mac`

Expected: packaged App contains `Contents/Resources/dao-acp-host/dao-acp-stdio-proxy.js` and every required local dependency; smoke test can launch the fake ACP child from packaged paths.

- [x] **Step 5: Install recoverably and perform real-app smoke**

Rename the existing `/Applications/Dao Flow.app` to a timestamped backup, copy the new build into `/Applications`, launch it, and verify runtime healthy plus Devin ACP detection. Create and stop a handshake-only test session in a temporary empty workspace; do not send a real user prompt or approve a real tool. Confirm no proxy/Devin ACP child remains afterward and checksum the Devin plugin directory before/after to prove it was untouched.

- [x] **Step 6: Close the plan**

Mark each checkbox complete only with recorded evidence. Run `git diff --check` on files changed by this plan and report any unrelated pre-existing dirty files separately instead of altering them.

## Completion evidence — 2026-08-11

- Desktop full suite: 60 files / 245 tests passed; TypeScript, ESLint (0 errors), Vite renderer build and Bun Electron build passed.
- Root routing/proxy suite: 351 assertions plus ACP workspace, lineage, stdio proxy and endpoint self-tests passed.
- macOS arm64 directory package completed. Packaged `dao-acp-host` contains the proxy and all four local dependencies; the packaged proxy SHA-256 matches the source.
- Recoverable install completed at `/Applications/Dao Flow.app`; previous builds remain timestamped beside it.
- Real-app smoke completed in `/tmp/dao-flow-devin-smoke`: Dao Runtime healthy, Devin detected, official ACP handshake completed, session model `SWE-1.6 Slow` appeared in `当前工作` as `Dao Flow · swe-1-6-slow`, and explicit stop removed the Dao Flow-owned proxy/Devin child processes.
- No prompt was sent and no tool permission was approved. The installed Devin plugin `extension.js` SHA-256 remained `97a73ae86dd9891c5ef81cda9cf72a28e442b864c406e0a3e7246a1f4a6546de` before and after smoke.

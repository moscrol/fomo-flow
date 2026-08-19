# Devin 原生入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use inline execution with test-first checkpoints.

**Goal:** Make the default Devin connection action open the installed Devin app and workspace while retaining Dao Flow's ACP host as an explicit advanced mode.

**Architecture:** Store selected workspace paths only in the Electron main process behind the existing opaque handle. Add a narrow `openDevinNative` IPC capability that opens the fixed Devin app and the selected directory; keep the existing ACP host handlers unchanged for advanced mode. The React view owns only mode selection and user-readable status.

**Tech Stack:** Electron IPC/contextBridge, React, TypeScript, Vitest, electron-builder.

---

### Task 1: Add the safe native-open IPC seam

**Files:**

- Modify: `desktop/electron/ipc/channels.ts`
- Modify: `desktop/electron/ipc/capabilities.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/electron/main.ts`
- Test: `desktop/electron/services/devin-native-launch.test.ts`

- [x] Write a pure launch service test proving a valid opaque handle opens the fixed Devin app and workspace, while invalid/unknown handles fail without exposing paths.
- [x] Implement a main-process native launcher using the host's in-memory handle map and the fixed Devin CLI with `--new-window --agents`.
- [x] Register a `dao:devin-native-open` IPC channel accepting only `{ workspaceHandle }`.
- [x] Expose `openDevinNative` through the preload bridge and add payload validation.
- [x] Run the focused launcher, capability, and host tests.

### Task 2: Split native and hosted modes in the React view

**Files:**

- Modify: `desktop/src/components/control/DevinConnectControlView.tsx`
- Modify: `desktop/src/components/control/DevinConnectControlView.test.tsx`
- Modify: `desktop/src/lib/desktopHost/index.ts`

- [x] Add a primary “打开 Devin 原生窗口” action after workspace selection; it calls `openDevinNative` and never calls `startDevinHost`.
- [x] Add an explicit secondary “高级：在 Dao Flow 托管 ACP” action that preserves the existing host flow.
- [x] Update title, description, status copy, and section numbering to make the two modes distinct.
- [x] Add tests for native success and hosted-mode opt-in; retain the prompt/permission tests for hosted mode.
- [x] Run the focused Devin view tests and typecheck.

### Task 3: Validate package and installed behavior

**Files:**

- Modify: `desktop/README.md`
- Test: existing Desktop suites and installed app.

- [x] Run `npm run test -- --maxWorkers=1`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run pack:mac`.
- [x] Install the arm64 app with a timestamped backup, launch it, choose a workspace, and verify the native Devin window opens.
- [x] Verify hosted ACP remains opt-in and route/priority remains unchanged.
- [x] Record residual risk: native Devin session events are observed only when Devin exposes them through the existing local observation source.

Installed verification: the default action opened a new `dao-proxy-pro` Devin Agents window. No process owned by `/Applications/Dao Flow.app` launched `dao-acp-stdio-proxy.js` or `devin acp`; the additional ACP processes belonged to the user's existing Devin extension and were not modified.

# Dao ACP Collaboration Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native Electron Task Center and ACP Session Workbench views backed by Dao's existing sanitized task/HUD projections.

**Architecture:** Keep the runtime and ACP execution paths unchanged. Extend the Electron control API allowlist with read-only task access, normalize `/origin/hud/snapshot` and `/origin/tasks` into a small renderer-owned collaboration model, and render two lazy-loaded React views using the existing Dao control primitives and theme tokens.

**Tech Stack:** Electron 39, React 18, TypeScript, Vite, lucide-react, Vitest, Testing Library.

---

### Task 1: Expose the read-only task endpoint through the Electron boundary

**Files:**
- Modify: `desktop/electron/services/dao-control.ts`
- Modify: `desktop/electron/services/dao-control.test.ts`

- [ ] **Step 1: Write the failing boundary assertions**

Add assertions that `GET /origin/tasks` and `GET /origin/tasks/job-1` are allowed, while `POST /origin/tasks` and `POST /origin/tasks/job-1/result` are rejected.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd desktop && bunx vitest run src/lib/../electron/services/dao-control.test.ts`

Expected: the new GET assertion fails because `/origin/tasks` is not in the read allowlist.

- [ ] **Step 3: Add the narrow read prefix**

Add `'/origin/tasks'` to `READ_PREFIXES`. Do not add it to `WRITE_PREFIXES`; the existing `hasPrefix` logic then permits the two GET paths and rejects task mutations. Add `requiresDaoTaskAuthorization()` and `readDaoLocalApiKey()` to the control service. In `electron/main.ts`, only for task paths, fetch the same-origin `/origin/revproxy/status`, keep its bounded `apiKey` in the main process, and send it as `Authorization: Bearer …`; never expose it through `desktopHost`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `cd desktop && bunx vitest run electron/services/dao-control.test.ts`

Expected: all Dao control boundary tests pass, including local-key extraction and task-path authorization matching.

### Task 2: Define and test the renderer collaboration model

**Files:**
- Create: `desktop/src/components/collaboration/collaborationModel.ts`
- Create: `desktop/src/components/collaboration/collaborationModel.test.ts`

- [ ] **Step 1: Write failing projection tests**

Cover these exact cases:

```ts
expect(normalizeCollaborationSnapshot({ sessions: [{ id: 's1', surface: 'codex', active: true }] }).sessions[0]).toMatchObject({
  id: 's1', surface: 'codex', active: true, warning: false
})
expect(normalizeTasks({ tasks: [{ jobId: 'j1', status: 'running', attempts: [{ provider: 'p1' }] }] }).tasks[0]).toMatchObject({
  jobId: 'j1', status: 'running', attemptCount: 1
})
expect(normalizeTasks({ tasks: [{ jobId: 'j2', result: { artifacts: [{ path: '/secret/full/path' }] } }] }).tasks[0].result.artifacts[0]).toEqual({ ref: 'path', kind: '' })
```

Also assert malformed arrays become empty and date/number formatters never throw.

- [ ] **Step 2: Run the model test and verify it fails**

Run: `cd desktop && bunx vitest run src/components/collaboration/collaborationModel.test.ts`

Expected: module/functions are missing.

- [ ] **Step 3: Implement bounded normalization**

Export `CollaborationSession`, `CollaborationTask`, `CollaborationAttempt`, `CollaborationArtifact`, `normalizeCollaborationSnapshot`, `normalizeTasks`, `taskCounts`, `surfaceLabel`, `taskStatusLabel`, `taskTone`, `formatRelativeAge`, and `formatDuration`. Reuse `asRecord`/`asArray`; cap all display strings at 220 characters, attempts at 8, artifacts at 20, and never expose raw prompt/session/path fields beyond the already projected `workspace` basename/ref.

- [ ] **Step 4: Run the model test and verify it passes**

Run: `cd desktop && bunx vitest run src/components/collaboration/collaborationModel.test.ts`

Expected: all projection tests pass.

### Task 3: Build the Task Center view

**Files:**
- Create: `desktop/src/components/control/TaskCenterControlView.tsx`
- Create: `desktop/src/components/control/TaskCenterControlView.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [ ] **Step 1: Write failing UI tests**

Mock `window.desktopHost.requestControl` for `/origin/tasks` and `/origin/hud/snapshot`; assert the page renders the heading `任务中心`, a running task, `fallback` attempt metadata, and an artifact reference. Assert selecting a status filter hides nonmatching tasks and an error response renders a visible error status.

- [ ] **Step 2: Run the UI test and verify it fails**

Run: `cd desktop && bunx vitest run src/components/control/TaskCenterControlView.test.tsx`

Expected: component is missing.

- [ ] **Step 3: Implement the view**

Use `ControlView`, `ControlReadoutGrid`, `ControlPanel`, `ControlBadge`, `ControlListEmpty`, `LoadingState`, `ControlStatus`, and `useDaoApi`. Refresh both endpoints every 3 seconds and on manual refresh. Render summary counts, a filter row (`全部/运行中/等待中/失联/失败/已完成`), a bounded task list, and selected-task detail with attempts and artifacts. Keep the page read-only; use `aria-pressed`, `aria-current`, and explicit labels for all filters.

- [ ] **Step 4: Add scoped CSS**

Add `.collaboration-*` classes for the task grid, filter bar, list rows, timeline, artifact cards, and empty/error states. Use existing CSS variables and responsive single-column behavior below 980px.

- [ ] **Step 5: Run the UI test and verify it passes**

Run: `cd desktop && bunx vitest run src/components/control/TaskCenterControlView.test.tsx`

Expected: all Task Center assertions pass.

### Task 4: Build the ACP Session Workbench view

**Files:**
- Create: `desktop/src/components/control/AcpWorkbenchControlView.tsx`
- Create: `desktop/src/components/control/AcpWorkbenchControlView.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [ ] **Step 1: Write failing UI tests**

Mock a HUD snapshot containing one active ACP session, one Codex session, a route, cache metrics, and recent requests. Assert the page renders `ACP 协作`, surface filtering changes the visible session set, and the selected session shows provider/upstream route facts and an activity item. Assert empty snapshots render the safe empty state.

- [ ] **Step 2: Run the UI test and verify it fails**

Run: `cd desktop && bunx vitest run src/components/control/AcpWorkbenchControlView.test.tsx`

Expected: component is missing.

- [ ] **Step 3: Implement the workbench**

Use the HUD snapshot only. Refresh every 3 seconds. Render a session list with `全部/ACP/CODEX/DEVIN` filters, a selected-session detail card with route chain, lifecycle, workspace basename, cache and latency readouts, and a chronological activity list synthesized from the selected session plus recent requests. If no session is selected, show an explicit no-session state; never display raw IDs beyond the already safe short projection.

- [ ] **Step 4: Add scoped CSS**

Add `.acp-workbench-*` classes for split-pane layout, session rows, route chain, facts, and activity feed, reusing `control-*` primitives and responsive collapse below 980px.

- [ ] **Step 5: Run the UI test and verify it passes**

Run: `cd desktop && bunx vitest run src/components/control/AcpWorkbenchControlView.test.tsx`

Expected: all ACP Workbench assertions pass.

### Task 5: Wire navigation and lazy loading

**Files:**
- Modify: `desktop/src/lib/views.ts`
- Modify: `desktop/src/components/Sidebar.tsx`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/App.test.tsx`

- [ ] **Step 1: Add view definitions and icons**

Add `collaboration` (`协作`) and `tasks` (`任务`) to `DAO_VIEWS`, `DAO_VIEW_DEFINITIONS`, and the sidebar icon map. Keep existing IDs and persisted view compatibility unchanged.

- [ ] **Step 2: Add lazy imports and render branches**

Lazy-load `AcpWorkbenchControlView` and `TaskCenterControlView`; render them for the new IDs while retaining `ViewPlaceholder` as fallback for any future ID.

- [ ] **Step 3: Extend App smoke coverage**

Add assertions that both new buttons appear and selecting `任务` renders the native heading. Existing overview expectations must remain unchanged.

- [ ] **Step 4: Run desktop tests**

Run: `cd desktop && bunx vitest run`

Expected: all existing and new tests pass.

### Task 6: Typecheck, lint, build and package verification

**Files:**
- Modify only files from Tasks 1–5 if fixes are required.

- [ ] **Step 1: Run typecheck and lint**

Run: `cd desktop && bun run typecheck && bun run lint`

Expected: both commands exit 0.

- [ ] **Step 2: Run the complete test suite**

Run: `cd desktop && bun run test`

Expected: all tests pass.

- [ ] **Step 3: Build the renderer and Electron main process**

Run: `cd desktop && bun run build && bun run build:electron`

Expected: `dist/` and `electron-dist/` build without errors.

- [ ] **Step 4: Verify diff hygiene**

Run: `git diff --check` and inspect only the intended files with `git status --short`.

Expected: no whitespace errors and no unrelated user files staged or modified by the implementation.

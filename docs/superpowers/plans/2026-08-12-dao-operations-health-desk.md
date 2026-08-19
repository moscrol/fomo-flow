# Dao Flow 运行运维健康桌 Implementation Plan

> **Execution record:** Implemented and verified on 2026-08-11. DAOFLOW-8 records the
> focused/full Desktop tests, arm64 package inspection, installed-app audit, and `in_review` handoff.

> **For agentic workers:** Execute this plan task-by-task in the current worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only operations health view to the existing traffic observation desk and quality-audit every primary module.

**Architecture:** A pure renderer projection converts existing safe runtime/HUD/Taskboard facts into six health items. A React control view reads only the existing three sources in parallel, renders the projection, and is added as one child of the existing traffic shell; no new endpoint, persistence, remote action, or route write is introduced.

**Tech Stack:** TypeScript, React 18, Vitest, Testing Library, existing Electron preload host, existing Dao control API.

---

### Task 1: Project Operations Health

**Files:**
- Create: `desktop/src/components/control/operationsModel.ts`
- Create: `desktop/src/components/control/operationsModel.test.ts`

- [x] **Step 1: Write failing projection tests**

Cover: healthy runtime with fresh HUD and connected Taskboard, stale HUD, offline runtime, degraded provider/session warning, no traffic as neutral, and serialization safety. Use `DaoDesktopStatus`, `HudSnapshot`, and `TaskboardSnapshot` fixtures with opaque IDs and absolute paths in input; assert output contains none.

- [x] **Step 2: Run the focused test and verify RED**

Run `cd desktop && npx vitest run src/components/control/operationsModel.test.ts --maxWorkers=1`. Expected failure: missing `operationsModel`.

- [x] **Step 3: Implement the pure projection**

Export `OperationsHealthTone`, `OperationsHealthItem`, `OperationsHealthSnapshot`, and `buildOperationsHealth(input)`. Keep the six item IDs stable: `runtime`, `observation`, `providers`, `sessions`, `requests`, `taskboard`. Use a 15-second HUD freshness warning threshold and never infer an incident from zero sessions or zero requests alone.

- [x] **Step 4: Run focused tests and typecheck the module**

Run the focused Vitest command and `npm run typecheck`. Expected: both pass.

### Task 2: Render the Operations Health View

**Files:**
- Create: `desktop/src/components/control/OperationsHealthControlView.tsx`
- Create: `desktop/src/components/control/OperationsHealthControlView.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write failing component tests**

Mock the existing `requestControl`, `getRuntimeStatus`, and `getTaskboardSnapshot` host reads. Assert the view shows `运行健康`, six health item labels, a partial-source state, and no raw ID/path/prompt/token. Assert refresh only calls `/origin/hud/snapshot` plus the existing host reads.

- [x] **Step 2: Run focused component tests and verify RED**

Run `npx vitest run src/components/control/OperationsHealthControlView.test.tsx --maxWorkers=1`. Expected failure: missing component.

- [x] **Step 3: Implement parallel safe reads and rendering**

Use `Promise.allSettled` so a failed HUD read does not hide runtime or Taskboard facts. Refresh every 5 seconds and update a one-second age clock. Provide only navigation buttons to existing `hud`, `providers`, `collaboration`, `work`, and `tasks` views; do not add action buttons that mutate state.

- [x] **Step 4: Add restrained responsive styling**

Use existing `ControlView`, `ControlPanel`, `ControlReadoutGrid`, and `ControlBadge` patterns. Render flat health rows with a stable grid; collapse rows to one column below 760px. Avoid nested cards and avoid exposing raw source payloads.

- [x] **Step 5: Run focused tests**

Run the component test and the operations model test. Expected: all pass.

### Task 3: Add the View to Traffic Observation

**Files:**
- Modify: `desktop/src/lib/views.ts`
- Modify: `desktop/src/components/Sidebar.tsx`
- Modify: `desktop/src/components/control/TrafficControlShell.tsx`
- Modify: `desktop/src/components/control/TrafficControlShell.test.tsx`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/App.test.tsx`
- Modify: `desktop/README.md`

- [x] **Step 1: Add `operations` to the existing traffic shell**

Register `operations` as a non-primary runtime view, add it after `overview` in `DAO_SHELL_CHILDREN.hud` and `TRAFFIC_ITEMS`, and map it to `OperationsHealthControlView` in `App.tsx`. Keep the four primary sidebar desks unchanged.

- [x] **Step 2: Extend navigation tests**

Assert `运行健康` is present under `流量观测`, active selection uses `aria-current="page"`, and App navigation renders the new view without changing the other traffic tabs.

- [x] **Step 3: Document the operational boundary**

Add one paragraph stating that Dao Flow monitors local runtime/Agent traffic and requires explicit user actions for any future restart, drain, or configuration write.

- [x] **Step 4: Run navigation tests**

Run `npx vitest run src/components/control/TrafficControlShell.test.tsx src/App.test.tsx --maxWorkers=1`. Expected: pass.

### Task 4: Full Validation and Module Quality Audit

**Files:**
- Review: `desktop/src/components/control/CurrentWorkControlView.tsx`
- Review: `desktop/src/components/control/HudControlView.tsx`
- Review: `desktop/src/components/control/AcpWorkbenchControlView.tsx`
- Review: `desktop/src/components/control/SettingsControlView.tsx`
- Review: `desktop/src/components/control/OperationsHealthControlView.tsx`

- [x] **Step 1: Run focused suites for all primary desks**

Run tests for Current Work, HUD, ACP, Settings, Traffic shell, Operations model/view, and App. Record failures and fix only regressions caused by this change.

- [x] **Step 2: Run Desktop typecheck, lint, full tests, build, and arm64 package**

Run `npm run typecheck`, `npm run lint`, `npm run test -- --maxWorkers=1`, `npm run build`, and `npm run pack:mac` from `desktop`.

- [x] **Step 3: Install and inspect the app**

Keep the current `/Applications/Dao Flow.app` as a timestamped backup, install the arm64 package, open `流量观测 → 运行健康`, and verify health rows, partial states, no sensitive fields, runtime health, and Taskboard health.

- [x] **Step 4: Perform the module audit**

Check each primary desk for: source/upstream naming, loading/error/empty states, stale-session behavior, no automatic route writes, no sensitive fields, accessible labels, and responsive layout. Record concrete residual risks.

- [x] **Step 5: Comment DAOFLOW-8 and move it to `in_review`**

After the final verification, add the changed files, test counts, packaging result, UI result, and residual risks to Taskboard. Read the latest issue version and move only to `in_review`; do not mark `done`.

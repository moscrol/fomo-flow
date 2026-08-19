# Dao Flow 五分钟实时桌退役 Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with focused tests and checkpoints.

**Goal:** Make every current-work session/task retire after five minutes without trusted activity, including attention items.

**Architecture:** Keep the lifecycle rule in the pure `workLifecycleProjection` domain layer. UI consumes the existing disposition and therefore needs only regression coverage and wording updates; history and Taskboard remain separate.

**Tech Stack:** TypeScript, React, Vitest, Vite desktop build.

---

### Task 1: Lock the lifecycle contract

**Files:**

- Modify: `desktop/src/components/work/workLifecycleProjection.test.ts`

- [x] Add a table test for blocked/warning sessions whose `latestActivityAt` is five minutes plus one millisecond old; expect `{ kind: 'closed' }`.
- [x] Replace the one-day task retention test with a table covering `failed`, `timed_out`, `detached`, and `transport_lost` at five minutes plus one millisecond; expect the unified task retirement reason.
- [x] Add an exact-five-minute attention boundary assertion; expect `{ kind: 'attention' }`.
- [x] Run `cd desktop && npx vitest run src/components/work/workLifecycleProjection.test.ts`; the implementation and regression suite now pass.

### Task 2: Apply one five-minute freshness gate

**Files:**

- Modify: `desktop/src/components/work/workLifecycleProjection.ts`

- [x] Remove the 24-hour attention retention constant.
- [x] After calculating `factAge`, return `{ kind: 'closed', reason: '任务超过 5 分钟无更新，已退出当前工作' }` whenever `factAge > TASK_FRESH_MS`, before checking running or attention status.
- [x] Keep the existing fresh running/attention reasons and opaque fingerprints unchanged.
- [x] Re-run the lifecycle test file and confirm all cases pass.

### Task 3: Verify the desk and update user-facing contract

**Files:**

- Modify: `desktop/src/components/control/CurrentWorkControlView.test.tsx`
- Modify: `desktop/README.md`
- Modify: `docs/superpowers/specs/2026-08-10-dao-current-work-taskboard-lifecycle-design.md`

- [x] Update the desk fixture to use a five-minute-plus-one-millisecond failed task and assert it is absent while a recent failed task remains.
- [x] Change documentation from a 24-hour attention window to the five-minute rule for all task statuses, explicitly preserving history.
- [x] Run focused current-work tests, then `npm test`, `npm run typecheck`, `npm run lint`, and `git diff --check`.

### Task 4: Build and install the desktop app

**Files:**

- Build output only: `desktop/release/`

- [x] Run `cd desktop && npm run pack:mac`.
- [x] Quit the running Dao Flow app, move it to an explicit timestamped backup, and install the new `desktop/release/*/Dao Flow.app` to `/Applications/Dao Flow.app`.
- [x] Launch the app and verify the current-work desk no longer shows stale attention items while a fresh live item remains.

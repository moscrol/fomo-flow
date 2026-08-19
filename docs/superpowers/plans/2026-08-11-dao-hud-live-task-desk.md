# Dao Flow HUD 实时任务桌 Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with focused tests and checkpoints.

**Goal:** Make the HUD long-task panel represent only tasks with a heartbeat in the last five minutes.

**Architecture:** A pure presentation projection splits normalized `HudTask` rows into live and retired sets. `HudTasks` uses that projection for counts and cards; snapshot transport remains unchanged.

**Tech Stack:** TypeScript, React, Vitest, Vite Electron desktop app.

---

### Task 1: Lock the live-task projection contract

**Files:**

- Modify: `desktop/src/components/control/hud/HudTasks.test.tsx`
- Modify: `desktop/src/components/control/hud/hudProjection.test.ts`

- [x] Add a HUD task fixture older than `5 * 60_000 + 1` milliseconds with status `failed`; expect it absent from “需要处理” and cards.
- [x] Add fresh `running` and fresh `failed` fixtures; expect the summary to remain `运行中 1` and `需要处理 1`.
- [x] Assert all-stale data renders the explicit live-empty message and retired count.
- [x] Add a blank session goal snapshot assertion expecting `当前会话未上报目标`.
- [x] Run the focused Vitest files; the new assertions were red before the projection was implemented and pass afterward.

### Task 2: Add the pure HUD task desk projection

**Files:**

- Modify: `desktop/src/components/control/hud/hudProjection.ts`
- Modify: `desktop/src/components/control/hud/HudTasks.tsx`

- [x] Export `HUD_LIVE_TASK_MS = 5 * 60_000` and `projectHudTaskDesk(tasks)` returning `{ live, retired }` based solely on `freshnessMs <= HUD_LIVE_TASK_MS`.
- [x] Compute summary counts and render cards from `live`; render retired history count separately.
- [x] When `live` is empty, render `当前没有正在心跳的登记任务。` and the nonzero retired count.
- [x] Change the safe blank goal fallback in `sessionFrom` to `当前会话未上报目标`.
- [x] Re-run focused tests and confirm they pass.

### Task 3: Verify desktop integration

**Files:**

- Modify: `desktop/README.md`

- [x] Document that the HUD long-task panel is a five-minute live window and that expired rows remain in task history.
- [x] Run `npm test`, `npm run typecheck`, `npm run lint -- --quiet`, `npx prettier --check` for touched files, and `git diff --check`.
- [x] Package/install the macOS app and confirm the actual HUD shows no stale tasks as running/attention while keeping the active Devin session visible.

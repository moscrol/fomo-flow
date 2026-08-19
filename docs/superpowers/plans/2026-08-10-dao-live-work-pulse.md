# Dao Live Work Pulse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use inline execution for this focused plan; do not delegate work or introduce new runtime services.

**Goal:** Make each current-work card explain the safely observed action, progress, and recent outcome without relying on a Claude-specific transcript.

**Architecture:** Extend the renderer-owned `WorkItem` projection with an optional bounded `pulse` derived only from already-normalized session/task facts. Keep `CurrentWorkControlView` presentation-only: it renders the pulse on cards and in the selected-item detail without adding requests, persistence, or route writes.

**Tech Stack:** React, TypeScript, Vitest, existing Dao sanitized HUD/tasks projections.

---

### Task 1: Project a bounded work pulse

**Files:**
- Modify: `desktop/src/components/work/workItemModel.ts`
- Test: `desktop/src/components/work/workItemModel.test.ts`

- [x] **Step 1: Write failing session and task pulse tests**

```ts
expect(desk.active[0].pulse).toEqual({
  current: '整理验证结果',
  progress: '1 / 3 项完成',
  outcome: '最近工具成功'
})
expect(desk.attention[0].pulse?.outcome).toBe('验证需要处理')
expect(desk.active.find((item) => item.kind === 'task')?.pulse).toEqual({
  current: '正在运行',
  progress: '运行中',
  outcome: '已尝试 1 次'
})
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `cd desktop && npm test -- --run src/components/work/workItemModel.test.ts`
Expected: FAIL because `pulse` is absent from `WorkItem`.

- [x] **Step 3: Add a renderer-only `WorkPulse` type and projection helpers**

```ts
export type WorkPulse = {
  current: string
  progress: string
  outcome: string
}

function sessionPulse(session: CollaborationSession): WorkPulse {
  return {
    current: sessionTodoTitle(session.todo.current) || safeText(session.phase, '等待状态', 80),
    progress: session.todo.total ? `${Math.min(session.todo.completed, session.todo.total)} / ${session.todo.total} 项完成` : '未提供计划',
    outcome: session.verification.blocking ? '验证需要处理' : session.failures.lastToolOk === false ? '最近工具失败' : session.failures.lastToolOk === true ? '最近工具成功' : '等待下一次活动'
  }
}
```

Use only existing safe task fields for task pulses. Pass every presentation string through `safeText`; do not add session/job identifiers to the pulse.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `cd desktop && npm test -- --run src/components/work/workItemModel.test.ts`
Expected: PASS.

### Task 2: Render the pulse in the current-work desk

**Files:**
- Modify: `desktop/src/components/control/CurrentWorkControlView.tsx`
- Modify: `desktop/src/theme/globals.css`
- Test: `desktop/src/components/control/CurrentWorkControlView.test.tsx`

- [x] **Step 1: Write failing component tests**

```tsx
expect(await screen.findByText('现在在做：整理验证结果')).toBeInTheDocument()
expect(screen.getByText('1 / 3 项完成 · 最近工具成功')).toBeInTheDocument()
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `cd desktop && npm test -- --run src/components/control/CurrentWorkControlView.test.tsx`
Expected: FAIL because work cards render only phase, route, age, and suggestion.

- [x] **Step 3: Render concise card and selected-detail pulse rows**

```tsx
{item.pulse && (
  <span className="work-item-card-pulse">
    现在在做：{item.pulse.current}
  </span>
)}
```

Add one scoped CSS rule group for `work-item-card-pulse` and `work-item-detail-pulse`. Keep labels readable at narrow widths and do not add a nested card.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `cd desktop && npm test -- --run src/components/control/CurrentWorkControlView.test.tsx`
Expected: PASS.

### Task 3: Verify the public boundary and package the app

**Files:**
- Modify: `desktop/README.md`

- [x] **Step 1: Document the fact boundary**

Add one sentence describing that current-work pulse uses only existing safe Todo, progress, verification, task result, and freshness facts; it does not read IDE transcripts or alter routing.

- [x] **Step 2: Run complete desktop verification**

Run: `cd desktop && npm test && npm run typecheck && npm run lint && git diff --check`
Expected: all tests and checks pass.

- [x] **Step 3: Build and install the macOS application**

Run: `cd desktop && npm run pack:mac`
Expected: `release/mac-arm64/Dao Flow.app` is produced. Replace `/Applications/Dao Flow.app` only after moving the existing app to a timestamped backup. Reopen Dao Flow and verify the live Devin card does not show `未识别任务目标` and exposes a pulse row.

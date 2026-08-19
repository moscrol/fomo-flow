# Dao Flow Current Work Desk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default `当前工作` desktop view that turns existing safe session and task projections into a single, actionable Work Item desk.

**Architecture:** `workItemModel.ts` is the sole renderer-owned aggregation seam. It receives already-normalized collaboration snapshots and tasks, performs a second bounded text pass, assigns each record to `attention`, `active`, or `completed`, and returns private in-memory navigation targets. `CurrentWorkControlView` reads only the existing HUD and task GET endpoints; `App` owns one-shot selection transfer into existing collaboration and task detail views.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, Testing Library, existing Electron loopback control API, lucide-react, CSS token system.

---

## File structure

| File | Responsibility |
| --- | --- |
| `desktop/src/components/work/workItemModel.ts` | Pure safe Work Item types, classification, sorting, empty desk. |
| `desktop/src/components/work/workItemModel.test.ts` | Deterministic classification, ordering, redaction, no guessed session/task joins. |
| `desktop/src/components/control/CurrentWorkControlView.tsx` | Three-section desk, polling and bounded HUD-task fallback. |
| `desktop/src/components/control/CurrentWorkControlView.test.tsx` | Endpoint, fallback, card navigation and no-write behavior. |
| `desktop/src/lib/views.ts` | Add the typed `work` view at the front of runtime navigation. |
| `desktop/src/App.tsx` | Make Work Desk default and transfer private selection tokens. |
| `desktop/src/components/control/AcpWorkbenchControlView.tsx` | Honor an optional in-memory session selection. |
| `desktop/src/components/control/TaskCenterControlView.tsx` | Honor an optional in-memory task selection. |
| `desktop/src/theme/globals.css` | Scoped Work Desk layout and responsive card rules. |
| `desktop/src/App.test.tsx` | Guard default Work Desk navigation and view reachability. |

### Task 1: Build the pure Work Item model

**Files:**
- Create: `desktop/src/components/work/workItemModel.ts`
- Create: `desktop/src/components/work/workItemModel.test.ts`

- [x] **Step 1: Write failing classification and privacy tests**

Create `workItemModel.test.ts` with fixtures built from the existing normalized shapes. The test must prove that a blocking session is attention, a running task is active, a succeeded task is completed, and private IDs/secrets/absolute paths do not enter title, phase, route or suggestion.

```ts
import { describe, expect, it } from 'vitest'
import { buildWorkDesk } from './workItemModel'

describe('buildWorkDesk', () => {
  it('sorts attention, active, and completed work without rendering private identifiers', () => {
    const desk = buildWorkDesk(
      {
        generatedAt: 1,
        runtime: { healthy: true, mode: 'desktop', port: 8955, connection: 'loopback' },
        providers: [],
        recentRequests: [],
        sessions: [
          {
            id: 'session-secret-123', surface: 'codex', active: true, requestInFlight: true,
            lifecycle: 'running', mode: 'default', identityKind: 'local', warning: true, stale: false,
            goal: '修复 Bearer sk-secret /Users/private/project', phase: '等待验证', workspace: 'project',
            latestActivityAt: 300, route: { provider: 'main', modelUid: 'dao-opus', upstreamModel: 'claude', provisional: false },
            telemetry: { ttftMs: null, durationMs: null, modelPath: '', loopSource: '', reasoningTokens: 0, compactions: 0 },
            cache: { observed: false, calls: 0, cached: 0, cacheWrite: 0, hitRate: 0 },
            todo: { completed: 0, total: 1, current: '验证' }, verification: { status: 'blocked', blocking: true },
            failures: { maxConsecutive: 0, sameCallStreak: 0, lastToolOk: null, hasLastError: false }
          }
        ]
      },
      [
        { jobId: 'job-running', source: 'devin', taskType: 'build', workspace: 'project', targetWorkspace: 'project', commandSummary: '构建', status: 'running', phase: '执行', progress: '50%', createdAt: 1, updatedAt: 200, lastHeartbeatAt: 200, recoveryReason: '', attempts: [], result: { status: 'unknown', exitCode: null, errorCategory: '', stdoutSummary: '', stderrSummary: '', finishedAt: 0, artifacts: [] } },
        { jobId: 'job-complete', source: 'acp', taskType: 'review', workspace: 'project', targetWorkspace: 'project', commandSummary: '审阅变更', status: 'succeeded', phase: '完成', progress: '100%', createdAt: 1, updatedAt: 100, lastHeartbeatAt: 100, recoveryReason: '', attempts: [], result: { status: 'succeeded', exitCode: 0, errorCategory: '', stdoutSummary: '', stderrSummary: '', finishedAt: 100, artifacts: [] } }
      },
      400
    )

    expect(desk.attention[0]).toMatchObject({ kind: 'session', target: { view: 'collaboration', id: 'session-secret-123' } })
    expect(desk.active[0]).toMatchObject({ kind: 'task', target: { view: 'tasks', id: 'job-running' } })
    expect(desk.completed[0]).toMatchObject({ kind: 'task', target: { view: 'tasks', id: 'job-complete' } })
    expect(JSON.stringify(desk)).not.toContain('sk-secret')
    expect(JSON.stringify(desk)).not.toContain('/Users/private')
  })
})
```

- [x] **Step 2: Run the focused model test and verify it fails**

Run: `cd desktop && npx vitest run src/components/work/workItemModel.test.ts`

Expected: FAIL because `workItemModel.ts` does not exist.

- [x] **Step 3: Implement the bounded model**

Create `workItemModel.ts`. Do not import React, call HTTP, write storage, or expose a rendered ID.

```ts
import type { CollaborationSession, CollaborationSnapshot, CollaborationTask, CollaborationTone } from '@/components/collaboration/collaborationModel'

export type WorkItemBucket = 'attention' | 'active' | 'completed'
export type WorkItemTarget = { view: 'collaboration' | 'tasks'; id: string }
export type WorkItem = {
  key: string
  kind: 'session' | 'task'
  bucket: WorkItemBucket
  source: string
  title: string
  phase: string
  route: string
  updatedAt: number
  tone: CollaborationTone
  suggestion: string
  target: WorkItemTarget
}
export type WorkDesk = { attention: WorkItem[]; active: WorkItem[]; completed: WorkItem[] }

const SECRET = /\b(?:Bearer\s+|sk-[A-Za-z0-9_-]{4,})[^\s]*/gi
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/Users\/|\/home\/|\/tmp\/)[^\s]*/g

function safeText(value: unknown, fallback: string, limit = 140): string {
  const text = String(value ?? '').replace(SECRET, '[已隐藏]').replace(ABSOLUTE_PATH, '[路径已隐藏]')
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
  return text || fallback
}

function sessionItem(session: CollaborationSession): WorkItem {
  const needsAttention = session.warning || session.stale || session.verification.blocking
  const bucket: WorkItemBucket = needsAttention ? 'attention' : session.active || session.requestInFlight ? 'active' : 'completed'
  const suggestion = session.verification.blocking ? '查看验证阻塞' : session.warning ? '查看失败信号' : session.stale ? '确认是否继续' : session.active ? '查看协作会话' : '查看会话记录'
  return {
    key: `session:${session.id}`, kind: 'session', bucket, source: safeText(session.surface.toUpperCase(), 'ACP', 30),
    title: safeText(session.goal, '未命名会话'), phase: safeText(session.phase, '等待状态'),
    route: safeText([session.route.provider, session.route.upstreamModel].filter(Boolean).join(' · '), '路由待确认', 100),
    updatedAt: session.latestActivityAt, tone: needsAttention ? (session.stale && !session.warning && !session.verification.blocking ? 'warn' : 'bad') : session.active ? 'good' : 'muted',
    suggestion, target: { view: 'collaboration', id: session.id }
  }
}

function taskItem(task: CollaborationTask): WorkItem {
  const attention = new Set(['failed', 'timed_out', 'cancelled', 'detached', 'transport_lost'])
  const active = new Set(['running', 'queued'])
  const bucket: WorkItemBucket = attention.has(task.status) ? 'attention' : active.has(task.status) ? 'active' : 'completed'
  const latest = task.attempts.at(-1)
  const suggestion = task.status === 'detached' || task.status === 'transport_lost' ? '检查连接后再处理' : attention.has(task.status) ? '查看失败与交接' : active.has(task.status) ? '查看任务详情' : '审阅任务产物'
  return {
    key: `task:${task.jobId}`, kind: 'task', bucket, source: safeText(task.source.toUpperCase(), 'ACP', 30),
    title: safeText(task.commandSummary || task.taskType, '未命名任务'), phase: safeText(task.phase || task.progress, '等待状态'),
    route: latest ? safeText(`${latest.provider} · ${latest.model}`, '路由待确认', 100) : '尚未选择渠道', updatedAt: task.updatedAt,
    tone: attention.has(task.status) ? (task.status === 'detached' || task.status === 'transport_lost' ? 'warn' : 'bad') : active.has(task.status) ? 'good' : 'muted',
    suggestion, target: { view: 'tasks', id: task.jobId }
  }
}

export function emptyWorkDesk(): WorkDesk {
  return { attention: [], active: [], completed: [] }
}

export function buildWorkDesk(snapshot: CollaborationSnapshot, tasks: CollaborationTask[]): WorkDesk {
  const desk = emptyWorkDesk()
  for (const item of [...snapshot.sessions.map(sessionItem), ...tasks.map(taskItem)]) desk[item.bucket].push(item)
  for (const bucket of Object.values(desk)) bucket.sort((left, right) => right.updatedAt - left.updatedAt)
  return desk
}
```

Use `session.warning || session.stale || session.verification.blocking` for attention before `session.active || session.requestInFlight`. Use `failed`, `timed_out`, `cancelled`, `detached`, and `transport_lost` as task attention statuses; use `running` and `queued` as active; use `succeeded` as completed; classify unknown terminal states as completed with muted tone. Derive a task route only from its latest attempt and render it as a bounded `provider · model` label; do not infer relations between sessions and tasks.

- [x] **Step 4: Run the focused model test and verify it passes**

Run: `cd desktop && npx vitest run src/components/work/workItemModel.test.ts`

Expected: PASS with the privacy assertions and three buckets.

- [x] **Step 5: Commit the pure-model slice**

```bash
git add desktop/src/components/work/workItemModel.ts desktop/src/components/work/workItemModel.test.ts
git commit -m "feat: add Dao work item model"
```

### Task 2: Render the current-work desk over existing read endpoints

**Files:**
- Create: `desktop/src/components/control/CurrentWorkControlView.tsx`
- Create: `desktop/src/components/control/CurrentWorkControlView.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write failing view tests for reads, fallback, and navigation**

Mock `window.desktopHost.requestControl`. Resolve `/origin/hud/snapshot`, reject `/origin/tasks`, then assert the component renders its fallback notice and never calls a method other than `GET`. In the success fixture click a work card and assert its private target is returned to the parent, not printed in the DOM.

```tsx
render(<CurrentWorkControlView onOpenItem={onOpenItem} />)
expect(await screen.findByRole('heading', { name: '当前工作' })).toBeInTheDocument()
expect(screen.getByText('任务详情接口暂不可用，当前显示 HUD 摘要。')).toBeInTheDocument()
expect(requestControl.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
await user.click(screen.getByRole('button', { name: /查看协作会话/ }))
expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ target: { view: 'collaboration', id: 'session-1' } }))
expect(screen.queryByText('session-1')).not.toBeInTheDocument()
```

- [x] **Step 2: Run the focused view test and verify it fails**

Run: `cd desktop && npx vitest run src/components/control/CurrentWorkControlView.test.tsx`

Expected: FAIL because `CurrentWorkControlView` does not exist.

- [x] **Step 3: Implement the read-only control view**

Use the same `useDaoApi`, `ControlView`, `ControlPanel`, `ControlListEmpty`, `ControlStatus`, and `LoadingState` pattern as `TaskCenterControlView`.

```tsx
export function CurrentWorkControlView({ onOpenItem }: { onOpenItem(item: WorkItem): void }) {
  const api = useDaoApi()
  const [desk, setDesk] = useState(emptyWorkDesk)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  async function refresh(): Promise<void> {
    const hud = await api.request('/origin/hud/snapshot')
    const snapshot = normalizeCollaborationSnapshot(hud)
    try {
      const taskPayload = await api.request('/origin/tasks')
      setDesk(buildWorkDesk(snapshot, normalizeTasks(taskPayload).tasks))
      setNotice('')
    } catch {
      setDesk(buildWorkDesk(snapshot, normalizeTasks({ tasks: asRecord(hud).tasks }).tasks))
      setNotice('任务详情接口暂不可用，当前显示 HUD 摘要。')
    }
  }
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3_000)
    return () => window.clearInterval(timer)
  }, [])
}
```

Render `需要我处理` first, then `正在进行`, then `最近完成`. Each section shows a reasoned empty state, for example `目前没有需要你处理的工作。` and `还没有记录到已完成的任务。`. `WorkItemCard` must be a button with `aria-label` based on safe title plus `查看协作会话` or `查看任务详情`; it calls `onOpenItem(item)` and never includes `item.target.id` in text, a DOM attribute, or a key visible to the user.

Add only scoped CSS:

```css
.work-desk-stack { display: grid; gap: 15px; }
.work-desk-section { display: grid; gap: 10px; }
.work-desk-list { display: grid; gap: 8px; }
.work-item-card { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; text-align: left; }
.work-item-card.tone-bad { border-color: color-mix(in srgb, var(--danger) 38%, var(--border)); }
@media (max-width: 760px) { .work-item-card { grid-template-columns: auto minmax(0, 1fr); } }
```

- [x] **Step 4: Run the focused view test and verify it passes**

Run: `cd desktop && npx vitest run src/components/control/CurrentWorkControlView.test.tsx src/components/work/workItemModel.test.ts`

Expected: PASS; the request mock observes only the two existing GET paths.

- [x] **Step 5: Commit the current-work view slice**

```bash
git add desktop/src/components/control/CurrentWorkControlView.tsx desktop/src/components/control/CurrentWorkControlView.test.tsx desktop/src/theme/globals.css
git commit -m "feat: add Dao current work desk"
```

### Task 3: Add typed navigation and detail selection transfer

**Files:**
- Modify: `desktop/src/lib/views.ts`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.tsx`
- Modify: `desktop/src/components/control/TaskCenterControlView.tsx`
- Modify: `desktop/src/App.test.tsx`

- [x] **Step 1: Extend App tests before changing navigation**

Add an assertion that `App` starts at `当前工作`, that the runtime navigation contains it before `首页`, and that selecting a work-card target navigates without a write request. Keep the existing test's assertions for all old view labels so the added view does not make a module unreachable.

```tsx
render(<App />)
expect(await screen.findByRole('heading', { name: '当前工作' })).toBeInTheDocument()
expect(screen.getByRole('button', { name: '当前工作' })).toBeInTheDocument()
```

- [x] **Step 2: Run the App test and verify it fails**

Run: `cd desktop && npx vitest run src/App.test.tsx`

Expected: FAIL because `work` is not a `DaoViewId` and the default remains `overview`.

- [x] **Step 3: Add the view and in-memory drill-in contract**

In `views.ts`, insert `work` into `DAO_VIEWS` and define it first in the runtime group.

```ts
{ id: 'work', label: '当前工作', description: '正在进行、需要处理和最近完成的 Agent 工作', eyebrow: '运行中', group: 'runtime' }
// runtime group order:
{ id: 'runtime', label: '运行中', views: ['work', 'overview', 'hud', 'observability'] }
```

In `App.tsx`, lazy-load the new view and use one private selection state:

```ts
const [drillIn, setDrillIn] = useState<{ sessionId: string; taskId: string }>({ sessionId: '', taskId: '' })

function openWorkItem(item: WorkItem): void {
  setDrillIn(item.kind === 'session' ? { sessionId: item.target.id, taskId: '' } : { sessionId: '', taskId: item.target.id })
  selectView(item.target.view)
}
```

Set `App`'s default `initialView` to `'work'`, render `<CurrentWorkControlView onOpenItem={openWorkItem} />`, pass `selectedSessionId={drillIn.sessionId}` to `AcpWorkbenchControlView`, and pass `selectedTaskId={drillIn.taskId}` to `TaskCenterControlView`.

Make each detail view prop optional and apply only after a corresponding normalized item exists:

```ts
useEffect(() => {
  if (selectedSessionId && snapshot.sessions.some((session) => session.id === selectedSessionId)) {
    setSelectedId(selectedSessionId)
  }
}, [selectedSessionId, snapshot.sessions])

useEffect(() => {
  if (selectedTaskId && tasks.some((task) => task.jobId === selectedTaskId)) {
    setFilter('all')
    setSelectedId(selectedTaskId)
  }
}, [selectedTaskId, tasks])
```

Do not write drill-in identifiers to localStorage; existing view-local saved session behavior remains unchanged when no Work Item drill-in is supplied.

- [x] **Step 4: Run the navigation and detail tests**

Run: `cd desktop && npx vitest run src/App.test.tsx src/components/control/AcpWorkbenchControlView.test.tsx src/components/control/TaskCenterControlView.test.tsx`

Expected: PASS with all pre-existing collaboration/task behavior intact and Current Work as the first runtime view.

- [x] **Step 5: Commit the navigation slice**

```bash
git add desktop/src/lib/views.ts desktop/src/App.tsx desktop/src/components/control/AcpWorkbenchControlView.tsx desktop/src/components/control/TaskCenterControlView.tsx desktop/src/App.test.tsx
git commit -m "feat: open Dao work items in detail views"
```

### Task 4: Verify the P0 desk and document the navigation contract

**Files:**
- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`

- [x] **Step 1: Update operator documentation**

Add `当前工作` as the first runtime view in both documents. State that it is a read-only aggregation of existing HUD/tasks data, that it does not infer session-task joins, and that low-frequency connection capabilities are still available but are not the normal starting point.

- [x] **Step 2: Run all desktop checks**

Run: `cd desktop && npm run typecheck && npm run lint && npm test && npm run build && npm run build:electron`

Expected: no type/lint errors; all existing and new Vitest files pass; Vite and Electron outputs build.

- [x] **Step 3: Run root smoke and inspect scope**

Run: `node --test test/dao-desktop-smoke.test.js && git diff --check HEAD~4..HEAD`

Expected: 2 / 2 smoke tests pass and the diff has no whitespace errors. Confirm no endpoint, IPC allowlist, provider configuration, routing dispatch, prompt, secret, or absolute-path behavior changed.

- [x] **Step 4: Commit the documentation and verification slice**

```bash
git add desktop/README.md docs/DAO_DESKTOP_PARITY.md
git commit -m "docs: describe Dao current work desk"
```

## Plan self-review

- **Spec coverage:** Task 1 implements the safe Work Item contract; Task 2 implements polling, fallback, empty states and no-write UI; Task 3 implements first-class navigation and private selection transfer; Task 4 covers documentation and all mandated checks.
- **Scope:** explicit interventions, terminal/artefact review, and advanced-connection navigation are intentionally deferred to `DAOFLOW-3`, `DAOFLOW-4`, and `DAOFLOW-5`.
- **Type consistency:** all tasks use `WorkItem`, `WorkItemTarget`, `WorkDesk`, `selectedSessionId`, and `selectedTaskId` exactly as declared above.
- **Execution completeness:** every code step declares the exact public types, classification order, endpoint behavior, and verification command needed for this P0 slice.

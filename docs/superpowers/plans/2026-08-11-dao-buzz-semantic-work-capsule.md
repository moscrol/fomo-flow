# Dao Flow Buzz Semantic Work Capsule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe renderer-owned DeskEvent layer, a direct Agent activity feed, and a selected-item work capsule over Dao Flow's existing HUD, task, Taskboard, decision, artifact, and handoff projections.

**Architecture:** Keep all network and Electron host reads in `CurrentWorkControlView`. Pure work-domain modules convert normalized safe inputs into bounded opaque `DeskEvent` and `WorkCapsule` values; presentational components receive only those values and callbacks. Requests remain global until an explicit safe owner key exists, and no route, provider, model, priority, endpoint, IPC, or remote execution behavior changes.

**Tech Stack:** React 19, TypeScript, Vite/Vitest, Testing Library, existing `useDaoApi`, existing Electron `desktopHost`, existing `sanitizeDisplayText`, CSS design tokens.

---

## File map

- Create `desktop/src/components/work/deskEventModel.ts`: DeskEvent types, opaque keys, safe event projection, filters, and work-capsule projection.
- Create `desktop/src/components/work/deskEventModel.test.ts`: public model seam tests for ordering, association, redaction, bounded evidence, and lifecycle truthfulness.
- Create `desktop/src/components/control/DeskActivityFeed.tsx`: result-first semantic event list and filters.
- Create `desktop/src/components/control/DeskActivityFeed.test.tsx`: accessible feed, filters, disclosure, empty state, and safe DOM tests.
- Create `desktop/src/components/control/WorkCapsulePanel.tsx`: selected work summary, reliable event timeline, and explicit callbacks.
- Create `desktop/src/components/control/WorkCapsulePanel.test.tsx`: session/task capsule and action-boundary tests.
- Modify `desktop/src/components/control/CurrentWorkControlView.tsx`: load decision inbox with existing GET, project events, compose feed and capsule, preserve polling/race/lifecycle behavior.
- Modify `desktop/src/components/control/CurrentWorkControlView.test.tsx`: integration tests for all sources, partial failure, GET-only behavior, retirement, selection, and no raw IDs.
- Modify `desktop/src/App.test.tsx`: prove default work view and explicit-only drill-in after the new composition.
- Modify `desktop/src/theme/globals.css`: scoped `desk-activity-*` and `work-capsule-*` styles only.
- Modify `desktop/README.md`: document Buzz semantic-layer boundaries and user-visible work flow.
- Modify `docs/DAO_DESKTOP_PARITY.md`: record native coverage and non-goals.

### Task 1: Project safe DeskEvent values

**Files:**
- Create: `desktop/src/components/work/deskEventModel.ts`
- Create: `desktop/src/components/work/deskEventModel.test.ts`

- [x] **Step 1: Write the first failing public-seam test**

Create a fixture containing one live Devin session, one recent cccc request, one running Codex task,
one Taskboard item, and one decision item. Assert fixed user-facing values rather than recomputing them:

```ts
const events = projectDeskEvents({ snapshot, tasks, taskboardItems, decisions, now })

expect(events.map(({ actor, verb, object, outcome }) => [actor, verb, object, outcome])).toEqual(
  expect.arrayContaining([
    ['Devin', '正在处理', '修复缓存观测', '进行中'],
    ['模型请求', '经过', 'cccc · gpt-5.6', '缓存命中'],
    ['Codex', '正在执行', '构建桌面应用', '运行中'],
    ['Taskboard', '跟踪', 'DAOFLOW-7 · Buzz 语义层', '进行中'],
    ['路由观察', '请求确认', '缓存命中率下降', '需要你确认']
  ])
)
```

Also assert request events have no `ownerKey`, session/task events have opaque `ownerKey`, and no
`key` or `ownerKey` contains the raw fixture IDs.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd desktop
npx vitest run src/components/work/deskEventModel.test.ts
```

Expected: FAIL because `deskEventModel.ts` and `projectDeskEvents` do not exist.

- [x] **Step 3: Implement the minimal event contract and projection**

Export these exact public types and functions:

```ts
export type DeskEventKind =
  | 'lifecycle' | 'progress' | 'request' | 'route' | 'tool'
  | 'task' | 'artifact' | 'approval' | 'handoff' | 'unknown'

export type DeskEventState =
  | 'running' | 'waiting' | 'success' | 'warning' | 'failure' | 'retired' | 'unknown'

export type DeskEventFilter = 'all' | 'attention' | 'traffic' | 'progress'

export type DeskEvent = {
  key: string
  at: number
  kind: DeskEventKind
  state: DeskEventState
  actor: string
  verb: string
  object: string
  outcome: string
  detail: string
  importance: 'high' | 'normal' | 'quiet'
  source: 'session' | 'request' | 'task' | 'taskboard' | 'decision'
  ownerKey?: string
  evidence: Record<string, boolean | number | string | null>
}

export type DeskEventInput = {
  snapshot: CollaborationSnapshot
  tasks: CollaborationTask[]
  taskboardItems: TaskboardWorkItem[]
  decisions: DecisionInboxItem[]
  now?: number
}

export function opaqueWorkOwner(kind: 'session' | 'task', rawId: string): string
export function projectDeskEvents(input: DeskEventInput): DeskEvent[]
export function deskEventMatchesFilter(event: DeskEvent, filter: DeskEventFilter): boolean
```

Use a deterministic non-reversible local hash for keys, `sanitizeDisplayText` for every string,
finite non-negative timestamps, safe scalar evidence, newest-first sorting, stable-key replacement,
and an 80-event limit. Project session events from session facts, request events globally, task events
including attempts/results/artifacts, Taskboard events from public identifiers, and approval events from
projected decision items.

- [x] **Step 4: Add one red-green test at a time for safety and association**

The retained public cases must prove:

```ts
expect(serialized).not.toMatch(/private-session|private-job|private-request/)
expect(serialized).not.toMatch(/Authorization|Bearer|sk-live|\/Users\/|C:\\/)
expect(requestEvent.ownerKey).toBeUndefined()
expect(sessionEvent.ownerKey).toBe(opaqueWorkOwner('session', 'private-session'))
expect(events).toHaveLength(80)
expect(events[0].at).toBeGreaterThanOrEqual(events[1].at)
```

Also use two concurrent Devin sessions and one Devin request to prove the request is not attached to either
session solely because `source === surface`.

- [x] **Step 5: Run model verification**

Run:

```bash
cd desktop
npx vitest run src/components/work/deskEventModel.test.ts
npx eslint src/components/work/deskEventModel.ts src/components/work/deskEventModel.test.ts --quiet
npm run typecheck
```

Expected: all commands exit 0.

### Task 2: Build WorkCapsule only from reliable ownership

**Files:**
- Modify: `desktop/src/components/work/deskEventModel.ts`
- Modify: `desktop/src/components/work/deskEventModel.test.ts`

- [x] **Step 1: Write a failing capsule test**

Use one selected session, one selected task, session-owned events, task-owned events, and global request events:

```ts
const capsule = buildWorkCapsule(sessionItem, events, undefined, true)

expect(capsule.current).toBe('整理验证结果')
expect(capsule.events.map((event) => event.source)).toEqual(['session'])
expect(capsule.events.some((event) => event.source === 'request')).toBe(false)
expect(capsule.hasHandoff).toBe(true)
expect(capsule.task).toBeUndefined()
```

Add a task case asserting its attempt/artifact events and normalized task are retained.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd desktop
npx vitest run src/components/work/deskEventModel.test.ts
```

Expected: FAIL because `buildWorkCapsule` is not exported.

- [x] **Step 3: Implement the public capsule seam**

Export:

```ts
export type WorkCapsule = {
  item: WorkItem
  events: DeskEvent[]
  current: string
  progress: string
  outcome: string
  route: WorkItem['routeFacts']
  task?: CollaborationTask
  hasHandoff: boolean
}

export function buildWorkCapsule(
  item: WorkItem,
  events: DeskEvent[],
  task: CollaborationTask | undefined,
  hasHandoff: boolean
): WorkCapsule
```

Derive the owner with `opaqueWorkOwner(item.kind, item.target.id)` and include only matching events.
Use the existing `item.pulse` values with honest fallbacks. Retain `task` only for task items; never infer a
task for a session.

- [x] **Step 4: Run the focused model suite**

Run:

```bash
cd desktop
npx vitest run src/components/work/deskEventModel.test.ts
```

Expected: PASS.

### Task 3: Render the direct Agent activity feed

**Files:**
- Create: `desktop/src/components/control/DeskActivityFeed.tsx`
- Create: `desktop/src/components/control/DeskActivityFeed.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write a failing accessible component test**

Render fixed success, approval, failure, and quiet events. Assert:

```ts
expect(screen.getByRole('region', { name: '刚刚发生' })).toBeInTheDocument()
expect(screen.getByText('Devin 正在处理 缓存观测')).toBeInTheDocument()
expect(screen.getByText('→ 测试通过')).toBeInTheDocument()
expect(screen.getByText('需要你确认')).toBeInTheDocument()

fireEvent.click(screen.getByRole('button', { name: '需要处理' }))
expect(screen.getByText('路由观察 请求确认 缓存下降')).toBeInTheDocument()
expect(screen.queryByText('读取运行状态')).not.toBeInTheDocument()

fireEvent.click(screen.getByText('查看安全证据'))
expect(screen.getByText(/"provider": "cccc"/)).toBeInTheDocument()
expect(document.body.textContent).not.toContain('private-session')
```

Add an empty-state case with `healthy=true` and a source-error case with `healthy=false`.

- [x] **Step 2: Run the component test and verify RED**

Run:

```bash
cd desktop
npx vitest run src/components/control/DeskActivityFeed.test.tsx
```

Expected: FAIL because `DeskActivityFeed` does not exist.

- [x] **Step 3: Implement the component**

Use this public interface:

```ts
export function DeskActivityFeed({
  events,
  now,
  healthy,
  onOpenDecisions
}: {
  events: DeskEvent[]
  now: number
  healthy: boolean
  onOpenDecisions?(): void
})
```

Render one stable row per event with `actor verb object`, `→ outcome`, detail, relative time, state badge,
and a native `<details>` containing `JSON.stringify(event.evidence, null, 2)`. Buttons switch among
`all/attention/traffic/progress` through `deskEventMatchesFilter`. Show “打开待确认事项” only when an
approval event exists and a callback is provided. Do not render event keys or owner keys.

- [x] **Step 4: Add scoped styles**

Add only `.desk-activity-*` selectors using existing `--border`, `--surface-low`, `--ink-muted`,
`--accent`, and tone tokens. Use a single-column mobile layout in the existing 760px media query.

- [x] **Step 5: Run component verification**

Run:

```bash
cd desktop
npx vitest run src/components/control/DeskActivityFeed.test.tsx src/components/work/deskEventModel.test.ts
npx eslint src/components/control/DeskActivityFeed.tsx src/components/control/DeskActivityFeed.test.tsx --quiet
npm run typecheck
```

Expected: all commands exit 0.

### Task 4: Render the selected work capsule

**Files:**
- Create: `desktop/src/components/control/WorkCapsulePanel.tsx`
- Create: `desktop/src/components/control/WorkCapsulePanel.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write a failing work-capsule behavior test**

Render a session capsule and assert direct facts and explicit actions:

```ts
expect(screen.getByRole('region', { name: '工作舱' })).toBeInTheDocument()
expect(screen.getByText('现在在做：整理验证结果')).toBeInTheDocument()
expect(screen.getByText('最近结果：测试通过')).toBeInTheDocument()
expect(screen.getByText('渠道 cccc · 模型 gpt-5.6')).toBeInTheDocument()
expect(screen.queryByText('private-session')).not.toBeInTheDocument()

fireEvent.click(screen.getByRole('button', { name: '打开协作会话' }))
expect(onOpenItem).toHaveBeenCalledTimes(1)
```

Add a task capsule case for “打开任务进度”, and prove acknowledge/promote controls render only for an
attention item with a fingerprint.

- [x] **Step 2: Run the component test and verify RED**

Run:

```bash
cd desktop
npx vitest run src/components/control/WorkCapsulePanel.test.tsx
```

Expected: FAIL because `WorkCapsulePanel` does not exist.

- [x] **Step 3: Implement the component**

Use this public interface:

```ts
export function WorkCapsulePanel({
  capsule,
  now,
  actionLoading,
  onOpenItem,
  onAcknowledge,
  onPromote,
  children
}: {
  capsule: WorkCapsule
  now: number
  actionLoading: boolean
  onOpenItem(): void
  onAcknowledge(): void
  onPromote(): void
  children?: ReactNode
})
```

Render one `<section aria-label="工作舱">` containing a `ControlPanel` summary, a compact read-only event
timeline, explicit action buttons, and `children`. The component never loads data and never calls route or
Taskboard APIs itself.

- [x] **Step 4: Add scoped styles and verify**

Add only `.work-capsule-*` selectors, then run:

```bash
cd desktop
npx vitest run src/components/control/WorkCapsulePanel.test.tsx
npx eslint src/components/control/WorkCapsulePanel.tsx src/components/control/WorkCapsulePanel.test.tsx --quiet
npm run typecheck
```

Expected: all commands exit 0.

### Task 5: Integrate events and capsule into Current Work

**Files:**
- Modify: `desktop/src/components/control/CurrentWorkControlView.tsx`
- Modify: `desktop/src/components/control/CurrentWorkControlView.test.tsx`
- Modify: `desktop/src/App.test.tsx`

- [x] **Step 1: Write the failing all-source integration test**

Mock existing GET responses for HUD, tasks, and decision inbox, plus an existing Taskboard snapshot. Assert:

```ts
expect(requestControl).toHaveBeenCalledWith('/origin/hud/snapshot', 'GET', undefined)
expect(requestControl).toHaveBeenCalledWith('/origin/tasks', 'GET', undefined)
expect(requestControl).toHaveBeenCalledWith('/origin/ea/decision-inbox?limit=50', 'GET', undefined)
expect(requestControl.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
expect(await screen.findByRole('region', { name: '刚刚发生' })).toBeInTheDocument()
expect(screen.getByText(/模型请求 经过 cccc/)).toBeInTheDocument()
expect(screen.getByText(/路由观察 请求确认/)).toBeInTheDocument()
```

Select a task and assert `工作舱`, its task events, artifact panel, intervention panel, and handoff actions
remain on the current page. Assert explicit “打开任务进度” is still the only navigation trigger.

- [x] **Step 2: Run the integration test and verify RED**

Run:

```bash
cd desktop
npx vitest run src/components/control/CurrentWorkControlView.test.tsx src/App.test.tsx
```

Expected: FAIL because Current Work does not request/project/render decision events or the new components.

- [x] **Step 3: Implement parallel reads and pure projection**

In `refresh`, run the three existing renderer GETs together:

```ts
const [hudPayload, tasksResult, decisionsResult] = await Promise.all([
  api.request('/origin/hud/snapshot'),
  api.request('/origin/tasks').then(ok).catch(failed),
  api.request('/origin/ea/decision-inbox?limit=50').then(ok).catch(failed)
])
```

Keep HUD authoritative: HUD failure retains prior desk/events and shows the existing retry error. Tasks failure
uses the HUD task fallback. Decision failure produces an empty decision source and a source-level notice without
removing session/request/task events. Preserve `refreshSeq` guards for every state write.

Store the normalized safe `CollaborationSnapshot`, normalized tasks, and projected decisions in renderer state,
then recompute events whenever those values or `taskboardSnapshot.items` change:

```ts
const events = useMemo(
  () => projectDeskEvents({ snapshot, tasks, taskboardItems: taskboardSnapshot.items, decisions, now }),
  [snapshot, tasks, taskboardSnapshot.items, decisions, now]
)
```

Do not use `now` in event keys; it is only for lifecycle/display calculations.

- [x] **Step 4: Compose the feed and work capsule**

Place `DeskActivityFeed` after the observation strip and before “需要我处理”. For a selected item, build a
capsule from the selected WorkItem, projected events, normalized task (task only), and Boolean handoff state.
Render `WorkCapsulePanel` around the existing intervention and artifact panels. Remove the private inline
`WorkItemDetailPanel` after its behavior is covered by the new component.

Pass `onNavigate('decisions')` only as the feed's explicit approval action. Preserve existing
`acknowledge`, `beginPromotion`, `onOpenItem`, `refreshIntervention`, and five-minute retirement behavior.

- [x] **Step 5: Add degradation, race, retirement, and privacy cases**

Retain or add fixed tests proving:

```ts
expect(screen.getByText('待确认事项暂时无法读取，其他工作事实仍可查看。')).toBeInTheDocument()
expect(screen.queryByText('超过五分钟的会话')).not.toBeInTheDocument()
expect(document.body.textContent).not.toMatch(/private-session|private-job|private-request/)
expect(document.body.textContent).not.toMatch(/Authorization|Bearer|sk-live|\/Users\/|C:\\/)
```

Use deferred promises to complete an older refresh after a newer refresh and assert it cannot replace the newer
events or error state.

- [x] **Step 6: Run focused integration verification**

Run:

```bash
cd desktop
npx vitest run \
  src/components/work/deskEventModel.test.ts \
  src/components/control/DeskActivityFeed.test.tsx \
  src/components/control/WorkCapsulePanel.test.tsx \
  src/components/control/CurrentWorkControlView.test.tsx \
  src/App.test.tsx
npm run typecheck
npm run lint -- --quiet
```

Expected: all commands exit 0.

### Task 6: Document, verify, inspect the packaged App, and hand off

**Files:**
- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`
- Modify: `docs/superpowers/plans/2026-08-11-dao-buzz-semantic-work-capsule.md` (checkboxes only)

- [x] **Step 1: Document the user-visible contract**

Record these exact boundaries in both docs:

```text
Current Work now uses one safe semantic feed for session, request, task, Taskboard, and approval facts.
Selected work opens a local work capsule containing only reliably associated facts.
Requests without an explicit owner key remain global; Dao Flow never guesses association from surface,
provider, model, time, or workspace. The feature is read-only and never changes configured priority.
```

Also state that Nostr, public Relay, chat, Git hosting, automatic dispatch, and remote Agent execution remain out
of scope.

- [x] **Step 2: Run the complete verification matrix**

Run:

```bash
cd desktop
npm test
npm run typecheck
npm run lint -- --quiet
npm run build
npm run build:electron
cd ..
node test/dao-desktop-smoke.test.js
git diff --check
```

Expected: every command exits 0. If lint reports warnings with exit 0, record the count; any error is a failure.

- [x] **Step 3: Inspect the real app path**

Start the packaged or development Electron App using the existing project command. Verify in the visible App:

1. Current Work shows “刚刚发生” before work sections.
2. A real recent request shows provider/model/cache result without appearing under an unrelated session.
3. Selecting a live session/task opens “工作舱” without navigating.
4. Explicit open buttons navigate to ACP/task details.
5. Five-minute-retired sessions/tasks do not return to live work.
6. No raw ID, Authorization, prompt, full path, or command text is visible.

- [x] **Step 4: Audit scope and dirty-worktree safety**

Run:

```bash
git status --short
git diff --name-only
git diff --check
```

Compare every touched file to this file map. Do not stage or overwrite unrelated pre-existing changes. Commit
only newly created isolated files when the index can be proven clean; leave overlapping integration hunks
unstaged and report them explicitly rather than sweeping user-owned changes into a commit.

- [x] **Step 5: Update Taskboard**

Read DAOFLOW-7 and its comments, add one comment containing implementation files, exact verification results,
real-app observations, and remaining risks. Read the issue again and move it to `in_review` with the current
version. Do not mark it `done`.

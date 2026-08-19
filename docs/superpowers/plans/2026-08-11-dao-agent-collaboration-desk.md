# Dao Agent Collaboration Desk Implementation Plan

> **Execution mode:** Implement locally, task by task, with tests first. Steps use checkbox (`- [ ]`) syntax for tracking. Do not delegate or overlap edits in the shared dirty worktree.

> **Shared-worktree note (2026-08-11):** All functional, test, package, and live-verification steps are complete. The commit-only steps remain intentionally unchecked because the working tree contains overlapping user-owned changes that must not be swept into broad commits.

**Goal:** Replace the configuration-heavy Dao Flow sidebar with four task-oriented shells and make existing ACP sessions, tasks, routing evidence, artifacts, and explicit handoff actions read as one local collaboration desk.

**Architecture:** Keep all existing view IDs and control components, add one `settings` shell ID, and introduce pure navigation/projection seams that map legacy views into Work, Traffic, ACP, and Settings. Shells compose existing safe views and endpoints; no new remote endpoint, automatic provider/model selection, priority write, or Devin-plugin mutation is allowed.

**Tech Stack:** React 19, TypeScript, Vite/Vitest, Electron main allowlisted IPC, existing Dao loopback HUD/tasks APIs, Lucide icons, CSS design tokens.

---

## File map

- `desktop/src/lib/views.ts`: define the 17 legal views, four primary shells, child-to-shell mapping, and command-palette ownership labels.
- `desktop/src/lib/views.test.ts`: lock view uniqueness, shell reachability, and hidden legacy-view compatibility.
- `desktop/src/components/Sidebar.tsx`: render only four primary entries while highlighting the owning shell for a child view.
- `desktop/src/components/Sidebar.test.tsx`: prove legacy configuration entries are hidden but the correct shell remains active.
- `desktop/src/components/CommandPalette.tsx`: keep all capabilities searchable while labeling their owning primary shell.
- `desktop/src/components/CommandPalette.test.tsx`: verify hidden configuration views remain reachable with honest ownership text.
- `desktop/src/components/SectionShellNav.tsx`: shared accessible sub-navigation for Traffic, ACP, and Settings.
- `desktop/src/components/SectionShellNav.test.tsx`: verify selected state and child navigation without writes.
- `desktop/src/components/control/SettingsControlView.tsx`: purpose-oriented settings landing page; navigation only.
- `desktop/src/components/control/SettingsControlView.test.tsx`: verify all retained configuration capabilities are reachable.
- `desktop/src/components/control/TrafficControlShell.tsx`: direct, beginner-facing ownership labels for HUD/overview/decisions/problems.
- `desktop/src/components/control/TrafficControlShell.test.tsx`: verify subview mapping and route-adjustment navigation.
- `desktop/src/components/control/hud/HudRequests.tsx`: rename the safe cache key column as cache/session affinity rather than an unexplained cache name.
- `desktop/src/components/control/hud/HudRequests.test.tsx`: verify the direct beginner-facing affinity label.
- `desktop/src/components/collaboration/collaborationDeskModel.ts`: pure safe projection of Agent roster, session lanes, and unlinked task summaries.
- `desktop/src/components/collaboration/collaborationDeskModel.test.ts`: prove no guessed session-task links and bounded safe summaries.
- `desktop/src/components/control/AcpWorkbenchControlView.tsx`: add task loading, Agent roster, collaboration lanes, and explicit links to detailed actions.
- `desktop/src/components/control/AcpWorkbenchControlView.test.tsx`: cover Agent/session/task/artifact visibility, fallback, and safe DOM.
- `desktop/src/App.tsx`: wrap legacy child views in their owning shell and preserve in-memory work selection.
- `desktop/src/App.test.tsx`: verify four-entry navigation, persisted hidden views, command-palette access, and drill-in.
- `desktop/src/theme/globals.css`: scoped shell, settings, roster, and collaboration-lane styles.
- `desktop/README.md`, `docs/DAO_DESKTOP_PARITY.md`: document the four-shell product model and honest ACP boundary.

### Task 1: Lock the four-shell navigation model

**Files:**
- Modify: `desktop/src/lib/views.ts`
- Modify: `desktop/src/lib/views.test.ts`
- Modify: `desktop/src/components/Sidebar.tsx` (exhaustive icon entry only)

- [x] **Step 1: Write failing shell-mapping tests**

Add tests that express the exact public navigation contract:

```ts
import {
  DAO_PRIMARY_VIEWS,
  DAO_VIEWS,
  primaryViewDefinitions,
  shellViewFor
} from './views'

it('keeps all legacy views and exposes exactly four primary shells', () => {
  expect(DAO_VIEWS).toHaveLength(17)
  expect(DAO_PRIMARY_VIEWS).toEqual(['work', 'hud', 'collaboration', 'settings'])
  expect(primaryViewDefinitions().map((view) => view.label)).toEqual([
    '当前工作',
    '流量观测',
    'ACP 协作',
    '设置'
  ])
})

it('maps every hidden child to one stable shell', () => {
  expect(shellViewFor('overview')).toBe('hud')
  expect(shellViewFor('decisions')).toBe('hud')
  expect(shellViewFor('observability')).toBe('hud')
  expect(shellViewFor('devinConnect')).toBe('collaboration')
  expect(shellViewFor('tasks')).toBe('collaboration')
  expect(shellViewFor('routes')).toBe('settings')
  expect(shellViewFor('customModels')).toBe('settings')
  expect(shellViewFor('tunnel')).toBe('settings')
})
```

- [x] **Step 2: Run the model tests and verify RED**

Run:

```bash
cd desktop
npm test -- --run src/lib/views.test.ts
```

Expected: FAIL because `settings`, `DAO_PRIMARY_VIEWS`, `shellViewFor`, and `primaryViewDefinitions` do not exist.

- [x] **Step 3: Implement the explicit shell map**

Add the `settings` ID and definition, rename the primary labels, and export the fixed mapping:

```ts
export const DAO_PRIMARY_VIEWS = ['work', 'hud', 'collaboration', 'settings'] as const
export type DaoPrimaryViewId = (typeof DAO_PRIMARY_VIEWS)[number]

export const DAO_SHELL_CHILDREN: Record<DaoPrimaryViewId, DaoViewId[]> = {
  work: ['work'],
  hud: ['hud', 'overview', 'decisions', 'observability'],
  collaboration: ['collaboration', 'devinConnect', 'tasks'],
  settings: [
    'settings',
    'providers',
    'routes',
    'customModels',
    'codex',
    'revproxy',
    'tunnel',
    'bridges',
    'connectors'
  ]
}

export function shellViewFor(view: DaoViewId): DaoPrimaryViewId {
  return (
    DAO_PRIMARY_VIEWS.find((shell) => DAO_SHELL_CHILDREN[shell].includes(view)) ?? 'work'
  )
}

export function primaryViewDefinitions(
  views: DaoViewDefinition[] = DAO_VIEW_DEFINITIONS
): DaoViewDefinition[] {
  return DAO_PRIMARY_VIEWS.map((id) => views.find((view) => view.id === id)).filter(
    (view): view is DaoViewDefinition => Boolean(view)
  )
}
```

Use these fixed definitions:

```ts
{ id: 'hud', label: '流量观测', description: '请求走向、缓存、亲和、延迟与异常', eyebrow: '控制桌', group: 'runtime' }
{ id: 'collaboration', label: 'ACP 协作', description: 'Agent、会话、任务、产物与人工交接', eyebrow: '控制桌', group: 'collaboration' }
{ id: 'settings', label: '设置', description: '渠道、优先级、Agent 接入与高级连接', eyebrow: '控制桌', group: 'config' }
```

Add `settings: Settings2` to Sidebar's exhaustive icon record in the same task. Do not change
Sidebar rendering yet; Task 2 owns that behavior.

- [x] **Step 4: Run navigation tests and typecheck**

Run:

```bash
cd desktop
npm test -- --run src/lib/views.test.ts
npm run typecheck
```

Expected: tests and typecheck PASS.

- [ ] **Step 5: Commit the navigation model**

```bash
git add desktop/src/lib/views.ts desktop/src/lib/views.test.ts desktop/src/components/Sidebar.tsx
git commit -m "feat: define Dao four-shell navigation"
```

### Task 2: Render only four primary sidebar entries

**Files:**
- Modify: `desktop/src/components/Sidebar.tsx`
- Modify: `desktop/src/components/Sidebar.test.tsx`
- Modify: `desktop/src/components/CommandPalette.tsx`
- Modify: `desktop/src/components/CommandPalette.test.tsx`
- Modify: `desktop/src/App.test.tsx`

- [x] **Step 1: Write failing sidebar tests**

Render the sidebar with all view definitions and assert the visible contract:

```tsx
render(
  <Sidebar
    activeView="routes"
    views={DAO_VIEW_DEFINITIONS}
    status={null}
    onOpenCommandPalette={vi.fn()}
    onSelect={onSelect}
  />
)

expect(screen.getAllByRole('button', { name: /当前工作|流量观测|ACP 协作|设置/ })).toHaveLength(4)
expect(screen.queryByRole('button', { name: '模型怎么走' })).not.toBeInTheDocument()
expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('aria-current', 'page')
fireEvent.click(screen.getByRole('button', { name: '设置' }))
expect(onSelect).toHaveBeenCalledWith('settings')
```

Add an App assertion that `⌘K` still finds `模型怎么走` and selects `routes`.
Add a Command Palette assertion that the result subtitle begins with `设置` instead of the old
`路由配置` group label.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd desktop
npm test -- --run src/components/Sidebar.test.tsx src/App.test.tsx
```

Expected: FAIL because the sidebar still renders grouped legacy views and has no Settings icon.

- [x] **Step 3: Replace grouped navigation with primary definitions**

Update imports and the icon record:

```tsx
import { Settings2 } from 'lucide-react'
import {
  primaryViewDefinitions,
  shellViewFor,
  type DaoViewDefinition,
  type DaoViewId
} from '@/lib/views'

const icons: Record<DaoViewId, LucideIcon> = {
  // retain every existing mapping
  settings: Settings2
}
```

Render one primary list and derive active state from the child:

```tsx
const activeShell = shellViewFor(activeView)

<nav className="view-nav" aria-label="Dao 主要功能">
  <div className="view-nav-items">
    {primaryViewDefinitions(views).map((view) => (
      <SidebarItem
        key={view.id}
        view={view}
        active={activeShell === view.id}
        onSelect={onSelect}
      />
    ))}
  </div>
</nav>
```

Remove the separate Homepage button and the advanced-collapse state from Sidebar only. Do not remove any view definition or command-palette result.

In Command Palette, replace the group-label lookup with the owning shell definition:

```tsx
const owner = DAO_VIEW_DEFINITIONS.find((candidate) => candidate.id === shellViewFor(view.id))
<small>{owner?.label ?? '当前工作'} · {view.description}</small>
```

- [x] **Step 4: Run focused tests, lint, and typecheck**

```bash
cd desktop
npm test -- --run src/components/Sidebar.test.tsx src/components/CommandPalette.test.tsx src/App.test.tsx
npm run typecheck
npx eslint --quiet src/components/Sidebar.tsx src/components/Sidebar.test.tsx src/components/CommandPalette.tsx src/components/CommandPalette.test.tsx src/App.test.tsx
```

Expected: all commands exit zero.

- [ ] **Step 5: Commit the primary sidebar**

```bash
git add desktop/src/components/Sidebar.tsx desktop/src/components/Sidebar.test.tsx desktop/src/components/CommandPalette.tsx desktop/src/components/CommandPalette.test.tsx desktop/src/App.test.tsx
git commit -m "feat: simplify Dao primary navigation"
```

### Task 3: Add reusable child navigation and the Settings shell

**Files:**
- Create: `desktop/src/components/SectionShellNav.tsx`
- Create: `desktop/src/components/SectionShellNav.test.tsx`
- Create: `desktop/src/components/control/SettingsControlView.tsx`
- Create: `desktop/src/components/control/SettingsControlView.test.tsx`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/App.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write failing component tests**

Cover accessible selection and navigation:

```tsx
render(
  <SectionShellNav
    label="设置分区"
    activeView="routes"
    items={[
      { id: 'settings', label: '设置首页' },
      { id: 'routes', label: '模型路由' }
    ]}
    onSelect={onSelect}
  />
)
expect(screen.getByRole('button', { name: '模型路由' })).toHaveAttribute('aria-current', 'page')
fireEvent.click(screen.getByRole('button', { name: '设置首页' }))
expect(onSelect).toHaveBeenCalledWith('settings')
```

Cover every retained settings capability:

```tsx
render(<SettingsControlView onNavigate={onNavigate} />)
for (const label of [
  '接入渠道',
  '模型路由',
  '自定义模型',
  'Codex 连接',
  '外部客户端',
  '本地接口',
  '协议兼容',
  '远程访问'
]) expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
```

- [x] **Step 2: Run focused tests and verify RED**

```bash
cd desktop
npm test -- --run src/components/SectionShellNav.test.tsx src/components/control/SettingsControlView.test.tsx src/App.test.tsx
```

Expected: FAIL because the components and `settings` App branch do not exist.

- [x] **Step 3: Implement the generic shell navigation**

Create a presentation-only component:

```tsx
export type SectionShellItem = { id: DaoViewId; label: string }

export function SectionShellNav({ label, activeView, items, onSelect }: {
  label: string
  activeView: DaoViewId
  items: SectionShellItem[]
  onSelect(view: DaoViewId): void
}) {
  return (
    <nav className="section-shell-nav" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={activeView === item.id ? 'page' : undefined}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}
```

- [x] **Step 4: Implement the Settings landing page**

Use three fixed groups and existing view IDs only:

```tsx
const GROUPS = [
  {
    title: '渠道与优先级',
    items: [
      { id: 'providers', label: '接入渠道', detail: '添加渠道并检查可用性' },
      { id: 'routes', label: '模型路由', detail: '维护规定好的渠道顺序' },
      { id: 'customModels', label: '自定义模型', detail: '组合多渠道模型' }
    ]
  },
  {
    title: 'Agent 接入',
    items: [
      { id: 'codex', label: 'Codex 连接', detail: '选择本地 Codex 上游' },
      { id: 'connectors', label: '外部客户端', detail: '查看 IDE 与客户端接法' }
    ]
  },
  {
    title: '高级连接',
    items: [
      { id: 'revproxy', label: '本地接口', detail: '查看本机 API 地址' },
      { id: 'bridges', label: '协议兼容', detail: '连接不同接口格式' },
      { id: 'tunnel', label: '远程访问', detail: '按需管理远程连接' }
    ]
  }
] satisfies Array<{ title: string; items: Array<{ id: DaoViewId; label: string; detail: string }> }>
```

Render `ControlView title="设置"` and cards that call only `onNavigate(item.id)`.

- [x] **Step 5: Wire Settings in App without duplicating writes**

Lazy-load `SettingsControlView`. For `settings`, render the landing page. For every Settings child, prepend `SectionShellNav` and render the existing control view unchanged:

```tsx
const SETTINGS_NAV = [
  { id: 'settings', label: '设置首页' },
  { id: 'providers', label: '渠道' },
  { id: 'routes', label: '路由' },
  { id: 'customModels', label: '自定义模型' },
  { id: 'codex', label: 'Codex' },
  { id: 'connectors', label: '外部接入' },
  { id: 'revproxy', label: '本地接口' },
  { id: 'bridges', label: '协议兼容' },
  { id: 'tunnel', label: '远程访问' }
] satisfies SectionShellItem[]
```

Do not move provider/route/custom-model request logic into the shell.
Build the existing child content first, derive `shellViewFor(activeView)` once, and apply exactly one
shell wrapper. A child view must never receive nested Settings/Traffic/ACP wrappers.

- [x] **Step 6: Add scoped shell styles and verify**

Use existing tokens only:

```css
.section-shell-stack { display: grid; gap: 14px; }
.section-shell-nav { display: flex; flex-wrap: wrap; gap: 8px; }
.section-shell-nav button[aria-current='page'] { color: var(--accent); border-color: var(--accent); }
.settings-group-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
```

Run:

```bash
cd desktop
npm test -- --run src/components/SectionShellNav.test.tsx src/components/control/SettingsControlView.test.tsx src/App.test.tsx
npm run typecheck
npx eslint --quiet src/components/SectionShellNav.tsx src/components/control/SettingsControlView.tsx src/App.tsx
```

Expected: all pass.

- [ ] **Step 7: Commit the Settings shell**

```bash
git add desktop/src/components/SectionShellNav.tsx desktop/src/components/SectionShellNav.test.tsx desktop/src/components/control/SettingsControlView.tsx desktop/src/components/control/SettingsControlView.test.tsx desktop/src/App.tsx desktop/src/App.test.tsx desktop/src/theme/globals.css
git commit -m "feat: add purpose-oriented Dao settings"
```

### Task 4: Compose the Traffic observation shell

**Files:**
- Create: `desktop/src/components/control/TrafficControlShell.tsx`
- Create: `desktop/src/components/control/TrafficControlShell.test.tsx`
- Modify: `desktop/src/components/control/hud/HudRequests.tsx`
- Modify: `desktop/src/components/control/hud/HudRequests.test.tsx`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/App.test.tsx`

- [x] **Step 1: Write failing Traffic shell tests**

```tsx
render(
  <TrafficControlShell activeView="decisions" onNavigate={onNavigate}>
    <h2>路由证据内容</h2>
  </TrafficControlShell>
)
expect(screen.getByRole('navigation', { name: '流量观测分区' })).toBeInTheDocument()
expect(screen.getByRole('button', { name: '为什么这样走' })).toHaveAttribute(
  'aria-current',
  'page'
)
expect(screen.getByRole('heading', { name: '路由证据内容' })).toBeInTheDocument()
```

In App, persist `decisions`, remount, and assert Sidebar highlights `流量观测` while the route evidence content remains visible.
In `HudRequests.test.tsx`, render one safe request and assert the table contains the header
`缓存 / 会话亲和` and does not contain unexplained `缓存名` copy.

- [x] **Step 2: Run focused tests and verify RED**

```bash
cd desktop
npm test -- --run src/components/control/TrafficControlShell.test.tsx src/App.test.tsx
```

Expected: FAIL because Traffic children are not wrapped.

- [x] **Step 3: Implement the presentation-only Traffic shell**

```tsx
const TRAFFIC_ITEMS = [
  { id: 'hud', label: '最近请求' },
  { id: 'overview', label: '现在是否正常' },
  { id: 'decisions', label: '为什么这样走' },
  { id: 'observability', label: '问题记录' }
] satisfies SectionShellItem[]

export function TrafficControlShell({ activeView, onNavigate, children }: PropsWithChildren<{
  activeView: DaoViewId
  onNavigate(view: DaoViewId): void
}>) {
  return (
    <div className="section-shell-stack">
      <SectionShellNav
        label="流量观测分区"
        activeView={activeView}
        items={TRAFFIC_ITEMS}
        onSelect={onNavigate}
      />
      {children}
    </div>
  )
}
```

Rename the existing recent-request column to `缓存 / 会话亲和` and keep rendering only the existing
bounded `request.cacheName` value. Do not expose the raw prompt-cache key or add a new renderer field.

- [x] **Step 4: Wrap all Traffic child views in App**

After selecting the existing content, wrap it when `shellViewFor(activeView) === 'hud'`. Keep all existing requests and route writes in their original child components. Ensure `DecisionCenterControlView` continues to receive `onNavigate` so “调整路由” opens `routes`, which Sidebar shows under Settings.
Reuse the single wrapper decision introduced in Task 3; do not wrap a child once in its branch and a
second time after the branch.

- [x] **Step 5: Verify Traffic behavior**

```bash
cd desktop
npm test -- --run src/components/control/TrafficControlShell.test.tsx src/components/control/HudControlView.test.tsx src/components/control/hud/HudRequests.test.tsx src/components/control/DecisionCenterControlView.test.tsx src/components/control/ObservabilityControlView.test.tsx src/App.test.tsx
npm run typecheck
npx eslint --quiet src/components/control/TrafficControlShell.tsx src/App.tsx
```

Expected: all pass; no test observes POST/PUT/DELETE from the shell.

- [ ] **Step 6: Commit the Traffic shell**

```bash
git add desktop/src/components/control/TrafficControlShell.tsx desktop/src/components/control/TrafficControlShell.test.tsx desktop/src/components/control/hud/HudRequests.tsx desktop/src/components/control/hud/HudRequests.test.tsx desktop/src/App.tsx desktop/src/App.test.tsx
git commit -m "feat: compose Dao traffic observations"
```

### Task 5: Add an honest Agent roster and collaboration lanes

**Files:**
- Create: `desktop/src/components/collaboration/collaborationDeskModel.ts`
- Create: `desktop/src/components/collaboration/collaborationDeskModel.test.ts`
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.tsx`
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write failing projection tests**

Use normalized safe fixtures and prove that tasks are not guessed onto sessions:

```ts
const desk = buildCollaborationDesk(
  {
    generatedAt: 1,
    sessions: [devinSession, codexSession],
    providers: [],
    recentRequests: [],
    runtime: { healthy: true, mode: 'desktop', port: 54500, connection: 'local' }
  },
  [taskWithTwoAttemptsAndOneArtifact]
)

expect(desk.agents.map((agent) => agent.label)).toEqual(['Devin · workspace-a', 'Codex · workspace-b'])
expect(desk.sessionLanes).toHaveLength(2)
expect(desk.unlinkedTasks).toEqual([
  expect.objectContaining({ title: '测试任务', attemptCount: 2, artifactCount: 1 })
])
expect(desk.links).toEqual([])
expect(JSON.stringify(desk)).not.toContain('session-secret')
expect(JSON.stringify(desk)).not.toContain('/Users/')
```

Add bounds: at most 20 agents, 20 session lanes, and 20 task summaries; preserve input order.

- [x] **Step 2: Run the model test and verify RED**

```bash
cd desktop
npm test -- --run src/components/collaboration/collaborationDeskModel.test.ts
```

Expected: FAIL because `buildCollaborationDesk` is absent.

- [x] **Step 3: Implement the pure safe projection**

Define these public types:

```ts
export type CollaborationDeskAgent = {
  key: string
  label: string
  surface: CollaborationSurface
  active: boolean
  phase: string
  model: string
  provider: string
  updatedAt: number
}

export type CollaborationDeskTask = {
  key: string
  title: string
  phase: string
  status: string
  attemptCount: number
  artifactCount: number
  updatedAt: number
}

export type CollaborationDesk = {
  agents: CollaborationDeskAgent[]
  sessionLanes: Array<{ key: string; agentKey: string; goal: string; current: string }>
  unlinkedTasks: CollaborationDeskTask[]
  links: Array<{ from: string; to: string }>
}
```

Keys are internal React keys derived from array position plus already-normalized surface; never render them. Because `CollaborationTask` has no trusted session reference, return `links: []` and all task summaries in `unlinkedTasks`. Use existing normalized `workspace`, `goal`, `phase`, route, attempts, and artifacts only.

- [x] **Step 4: Add task data to the ACP refresh boundary**

In `AcpWorkbenchControlView.refresh`, request HUD and tasks concurrently:

```ts
const [hudResult, taskResult] = await Promise.allSettled([
  api.request('/origin/hud/snapshot'),
  api.request('/origin/tasks')
])
if (hudResult.status === 'rejected') throw hudResult.reason
const next = normalizeCollaborationSnapshot(hudResult.value)
const nextTasks =
  taskResult.status === 'fulfilled' ? normalizeTasks(taskResult.value).tasks : []
```

Keep the last safe snapshot on a transient HUD error, add the same refresh-sequence guard already used by Current Work, and show `任务详情暂不可用，会话观测仍正常。` when only tasks fail.

- [x] **Step 5: Render Agent roster and collaboration lanes**

Above the existing session split grid, render:

```tsx
<ControlPanel title="Agent 名册" note={`${desk.agents.length} 个安全身份`}>
  <div className="collaboration-agent-roster" role="list" aria-label="Agent 名册">
    {desk.agents.map((agent) => (
      <article key={agent.key} role="listitem">
        <strong>{agent.label}</strong>
        <span>{agent.active ? '正在工作' : '最近出现'}</span>
        <small>{agent.model} · {agent.provider}</small>
      </article>
    ))}
  </div>
</ControlPanel>
```

Render a `协作链` panel with session lanes followed by a visibly separate `尚未关联到会话的任务` lane. Task cards show phase, attempts, artifact count, and a button that calls a new `onNavigate('tasks')` prop. Do not draw a connector between unlinked task and any session.

Rename the existing page description to: `一张桌查看 Agent、会话、任务、路由证据、产物与人工交接。没有可靠关系的数据会分开显示。`

Remove the existing provider/model fallback from `relatedRequests`. A request may appear under a
session only when its normalized source is a trusted exact match for that session. Two sessions using
the same provider/model must not share activity merely because their routes match.

- [x] **Step 6: Add integration and safety tests**

Assert:

```tsx
expect(await screen.findByRole('heading', { name: 'Agent 名册' })).toBeInTheDocument()
expect(screen.getByText('Devin · workspace-a')).toBeInTheDocument()
expect(screen.getByRole('heading', { name: '协作链' })).toBeInTheDocument()
expect(screen.getByText('尚未关联到会话的任务')).toBeInTheDocument()
expect(screen.getByText('尝试 2 次 · 产物 1 项')).toBeInTheDocument()
expect(screen.queryByText('session-secret')).not.toBeInTheDocument()
expect(screen.queryByText('/Users/a77/private')).not.toBeInTheDocument()
expect(requestControl).toHaveBeenCalledWith('/origin/hud/snapshot', 'GET', undefined)
expect(requestControl).toHaveBeenCalledWith('/origin/tasks', 'GET', undefined)
```

Add a race test in which an older refresh resolves last and cannot replace the newer roster/tasks.
Add a regression with two sessions on the same provider/model and prove that one session's request is
not shown under the other session without a trusted source match.

- [ ] **Step 7: Verify and commit the collaboration desk**

```bash
cd desktop
npm test -- --run src/components/collaboration/collaborationDeskModel.test.ts src/components/control/AcpWorkbenchControlView.test.tsx
npm run typecheck
npx eslint --quiet src/components/collaboration/collaborationDeskModel.ts src/components/control/AcpWorkbenchControlView.tsx
cd ..
git add desktop/src/components/collaboration/collaborationDeskModel.ts desktop/src/components/collaboration/collaborationDeskModel.test.ts desktop/src/components/control/AcpWorkbenchControlView.tsx desktop/src/components/control/AcpWorkbenchControlView.test.tsx desktop/src/theme/globals.css
git commit -m "feat: make ACP collaboration visible"
```

### Task 6: Compose the ACP shell and preserve drill-in

**Files:**
- Create: `desktop/src/components/control/CollaborationControlShell.tsx`
- Create: `desktop/src/components/control/CollaborationControlShell.test.tsx`
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/App.test.tsx`
- Modify: `desktop/src/components/control/CurrentWorkControlView.test.tsx`

- [x] **Step 1: Write failing shell/drill-in tests**

```tsx
render(
  <CollaborationControlShell activeView="tasks" onNavigate={onNavigate}>
    <h2>任务详情</h2>
  </CollaborationControlShell>
)
expect(screen.getByRole('button', { name: '任务与产物' })).toHaveAttribute(
  'aria-current',
  'page'
)
```

In the App test, click a Current Work session card, then its explicit `打开协作会话` action. Assert the ACP shell remains highlighted and the selected session appears. Repeat for a task and `打开任务进度`.

- [x] **Step 2: Run focused tests and verify RED**

```bash
cd desktop
npm test -- --run src/components/control/CollaborationControlShell.test.tsx src/components/control/CurrentWorkControlView.test.tsx src/App.test.tsx
```

Expected: FAIL because ACP child views are not composed under one shell.

- [x] **Step 3: Implement the ACP child navigation**

```tsx
const COLLABORATION_ITEMS = [
  { id: 'collaboration', label: '协作总览' },
  { id: 'devinConnect', label: '添加 Agent' },
  { id: 'tasks', label: '任务与产物' }
] satisfies SectionShellItem[]
```

Render `SectionShellNav label="ACP 协作分区"` and the child. This shell performs no requests or writes.

- [x] **Step 4: Wrap ACP children and keep safe selections in memory**

In App, wrap `collaboration`, `devinConnect`, and `tasks` when `shellViewFor(activeView) === 'collaboration'`. Preserve the existing `workSelection` object and do not add IDs to localStorage, URL, document title, or DOM attributes.

Use the same single wrapper decision as Traffic and Settings so every legacy child has exactly one
owning shell.

Pass `onNavigate={selectView}` to `AcpWorkbenchControlView` so its task-lane action opens `tasks`.

- [ ] **Step 5: Verify shell behavior and commit**

```bash
cd desktop
npm test -- --run src/components/control/CollaborationControlShell.test.tsx src/components/control/CurrentWorkControlView.test.tsx src/components/control/AcpWorkbenchControlView.test.tsx src/App.test.tsx
npm run typecheck
npx eslint --quiet src/components/control/CollaborationControlShell.tsx src/App.tsx
cd ..
git add desktop/src/components/control/CollaborationControlShell.tsx desktop/src/components/control/CollaborationControlShell.test.tsx desktop/src/App.tsx desktop/src/App.test.tsx desktop/src/components/control/CurrentWorkControlView.test.tsx
git commit -m "feat: compose Dao ACP collaboration shell"
```

### Task 7: Documentation, full quality gate, packaging, and live verification

**Files:**
- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`

- [x] **Step 1: Update user-facing documentation**

Document exactly:

- four primary entries and the Settings location of legacy route/config pages;
- ACP desk sections and the fact that unlinked tasks remain unlinked;
- Markdown handoff is user-triggered copy/save, not automatic transfer;
- no automatic priority/provider/model changes;
- no new remote service and no Devin-plugin modification.

- [x] **Step 2: Run focused product-contract tests**

```bash
cd desktop
npm test -- --run src/lib/views.test.ts src/components/Sidebar.test.tsx src/components/SectionShellNav.test.tsx src/components/control/SettingsControlView.test.tsx src/components/control/TrafficControlShell.test.tsx src/components/collaboration/collaborationDeskModel.test.ts src/components/control/AcpWorkbenchControlView.test.tsx src/components/control/CollaborationControlShell.test.tsx src/App.test.tsx
```

Expected: all test files and tests pass.

- [x] **Step 3: Run the full Desktop and root gates**

```bash
cd desktop
npm test
npm run typecheck
npm run lint
npm run build
cd ..
npm test
git diff --check
```

Expected: zero test/type/lint errors; existing non-error Prettier warnings may remain only in files not touched by this plan.

- [x] **Step 4: Package and install recoverably**

Record the Devin extension checksum before packaging. Run:

```bash
cd desktop
npm run pack:mac
```

Quit Dao Flow, move the existing `/Applications/Dao Flow.app` to a timestamped sibling backup, copy `desktop/release/mac-arm64/Dao Flow.app` into `/Applications`, and reopen it. Never overwrite the backup.

- [x] **Step 5: Perform live App verification**

Verify in the installed App:

- exactly four primary Sidebar entries;
- hidden `模型路由` reachable from Settings and `⌘K`;
- Traffic shows real recent model/channel/cache/affinity facts;
- ACP desk shows safe Agent/session/task summaries and no guessed link;
- Current Work session/task actions drill into the ACP shell;
- Desktop runtime health endpoint is healthy.

Recompute the Devin extension checksum and require it to equal the pre-install value.

- [ ] **Step 6: Commit docs and record verification**

```bash
git add desktop/README.md docs/DAO_DESKTOP_PARITY.md docs/superpowers/plans/2026-08-11-dao-agent-collaboration-desk.md
git commit -m "docs: complete Dao collaboration desk rollout"
```

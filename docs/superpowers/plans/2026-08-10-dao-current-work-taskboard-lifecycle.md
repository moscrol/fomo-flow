# Dao Current Work and Taskboard Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `当前工作` into a quiet real-time desk that removes terminal work, lets users explicitly dismiss failures, and shows the current repository's durable Taskboard plan and review items without automatic routing or Taskboard writes.

**Architecture:** Keep runtime lifecycle classification in pure renderer-side projection modules, but keep all persistence, launcher discovery, Taskboard challenge URLs, workspace paths, and write attribution inside Electron main-process services. The renderer receives only bounded safe projections through fixed IPC capabilities; Taskboard creation remains explicitly confirmed and is disabled unless the Electron process has a real `CODEX_THREAD_ID`.

**Tech Stack:** Node.js runtime projection, React 18, TypeScript 5.9, Electron 39 IPC, Vitest/Testing Library, Bun/electron-builder, local Taskboard launcher HTTP API

---

## File map

- `core/web_hud_projection.js`: resolve stale hydrated Codex activity before the desktop sees it.
- `test/web-hud-projection.test.js`: lock the upstream lifecycle boundary.
- `desktop/src/components/work/workLifecycleProjection.ts`: pure session/task disposition and opaque renderer fingerprint.
- `desktop/src/components/work/workLifecycleProjection.test.ts`: terminal, stale, failure, and fingerprint tests.
- `desktop/src/components/work/workItemModel.ts`: build only `attention` and `active` work buckets.
- `desktop/src/components/work/workItemModel.test.ts`: remove completed expectations and cover terminal filtering.
- `desktop/electron/services/work-attention-ledger.ts`: atomic, bounded SHA-256 acknowledgement ledger.
- `desktop/electron/services/work-attention-ledger.test.ts`: persistence, pruning, and corruption recovery.
- `desktop/electron/services/taskboard-local.ts`: loopback-only launcher discovery, safe project projection, and attributed creation.
- `desktop/electron/services/taskboard-local.test.ts`: URL, secret, workspace mapping, read, and write boundary tests.
- `desktop/electron/ipc/channels.ts`: fixed work-attention and Taskboard channels.
- `desktop/electron/ipc/capabilities.ts`: exact payload schemas for those channels.
- `desktop/electron/ipc/capabilities.test.ts`: reject raw paths, arbitrary URLs, commands, and malformed writes.
- `desktop/electron/preload.ts`: expose narrow methods to the renderer.
- `desktop/electron/main.ts`: compose services, file picker, and IPC handlers.
- `desktop/src/lib/desktopHost/index.ts`: typed renderer host contract and unavailable fallbacks.
- `desktop/src/components/control/TaskboardWorkPanel.tsx`: read-only plan/review list and connection state.
- `desktop/src/components/control/TaskboardWorkPanel.test.tsx`: plan sorting, safe display, and connect action.
- `desktop/src/components/control/PromoteWorkDialog.tsx`: safe preview and explicit creation confirmation.
- `desktop/src/components/control/PromoteWorkDialog.test.tsx`: zero-write-before-confirm and attribution gating.
- `desktop/src/components/control/CurrentWorkControlView.tsx`: combine live desk, acknowledgements, Taskboard, and history actions.
- `desktop/src/components/control/CurrentWorkControlView.test.tsx`: complete user-flow integration.
- `desktop/src/theme/globals.css`: scoped work desk, Taskboard, and dialog presentation.
- `desktop/README.md`, `docs/DAO_DESKTOP_PARITY.md`: user-facing behavior and safety boundaries.

### Task 1: Fix stale upstream session lifecycle

**Files:**
- Modify: `core/web_hud_projection.js:130-180`
- Modify: `test/web-hud-projection.test.js:520-565`

- [x] **Step 1: Write the failing stale-hydration assertions**

Add a stale active summary and assert it remains visible as an attention fact, not healthy active work:

```js
const pinned = retention.sessions.find((session) => session.goal === "Pinned active session");
assert(pinned);
assert.strictEqual(pinned.active, false);
assert.strictEqual(pinned.requestInFlight, false);
assert.strictEqual(pinned.lifecycle, "stale");
assert.strictEqual(pinned.stale, true);

const staleInFlight = createWebHudSnapshot({
  now,
  agentSummaries: [agent("hydrated-in-flight", {
    mode: "on",
    activation: { state: "active" },
    activity: {
      requestInFlight: true,
      lastRequestAt: now - 3_600_000,
      lastUpdateAt: now - 3_600_000,
    },
  })],
}).sessions[0];
assert.strictEqual(staleInFlight.lifecycle, "stale");
assert.strictEqual(staleInFlight.active, false);
assert.strictEqual(staleInFlight.requestInFlight, false);
```

- [x] **Step 2: Run the root projection test and confirm RED**

Run: `node test/web-hud-projection.test.js`

Expected: FAIL because the pinned summary is still `active` and `requestInFlight` remains true.

- [x] **Step 3: Make terminal freshness win over hydrated booleans**

Replace the current active calculation in `projectSession` with:

```js
const stale = freshnessMs > STALE_TTL_MS;
const requestedActive = activation.state === "active" && (
  summary.mode === "on" ||
  activity.requestInFlight === true ||
  freshnessMs <= ACTIVE_TTL_MS
);
const active = requestedActive && !stale;
const stalePinned = stale && (
  activation.state === "active" || activity.requestInFlight === true
);
```

Project the consistent values:

```js
active,
lifecycle: stalePinned ? "stale" : active ? "active" : "recently-ended",
stale,
requestInFlight: !stale && activity.requestInFlight === true,
```

- [x] **Step 4: Run focused and adjacent root tests**

Run: `node test/web-hud-projection.test.js && node test/web-hud-service.test.js`

Expected: both commands exit 0.

- [x] **Step 5: Commit only the upstream lifecycle files**

```bash
git add core/web_hud_projection.js test/web-hud-projection.test.js
git commit -m "fix: close stale active work sessions"
```

### Task 2: Add a pure live-work lifecycle projection

**Files:**
- Create: `desktop/src/components/work/workLifecycleProjection.ts`
- Create: `desktop/src/components/work/workLifecycleProjection.test.ts`
- Modify: `desktop/src/components/work/workItemModel.ts`
- Modify: `desktop/src/components/work/workItemModel.test.ts`

- [x] **Step 1: Write the disposition matrix tests**

Create normalized fixtures and assert the complete matrix:

```ts
expect(projectSessionDisposition(stopped, NOW)).toMatchObject({ kind: 'closed' })
expect(projectSessionDisposition(freshActive, NOW)).toMatchObject({ kind: 'running' })
expect(projectSessionDisposition(staleActive, NOW)).toMatchObject({
  kind: 'attention',
  reason: '状态可能已过期，请确认连接'
})
expect(projectTaskDisposition(task('queued'))).toMatchObject({ kind: 'running' })
expect(projectTaskDisposition(task('running'))).toMatchObject({ kind: 'running' })
for (const status of ['failed', 'timed_out', 'detached', 'transport_lost']) {
  expect(projectTaskDisposition(task(status))).toMatchObject({ kind: 'attention' })
}
for (const status of ['succeeded', 'cancelled']) {
  expect(projectTaskDisposition(task(status))).toMatchObject({ kind: 'closed' })
}
```

Also prove fingerprint properties:

```ts
const first = projectTaskDisposition(task('failed'))
const again = projectTaskDisposition(task('failed'))
expect(first).toEqual(again)
expect(first.kind === 'attention' && first.fingerprint).toMatch(/^[a-f0-9]{32}$/)
expect(JSON.stringify(first)).not.toContain('private-job-id')
```

- [x] **Step 2: Run the new test and confirm RED**

Run: `cd desktop && npm test -- --run src/components/work/workLifecycleProjection.test.ts`

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the pure projection and opaque fingerprint**

Define the public contract:

```ts
export type LiveWorkDisposition =
  | { kind: 'running'; reason: string }
  | { kind: 'attention'; reason: string; fingerprint: string }
  | { kind: 'closed'; reason: string }

const TERMINAL_SESSION = new Set(['stopped', 'closed', 'completed', 'cancelled'])
const RUNNING_TASK = new Set(['queued', 'running'])
const ATTENTION_TASK = new Set(['failed', 'timed_out', 'detached', 'transport_lost'])
const SESSION_FRESH_MS = 10 * 60 * 1_000
```

Use a deterministic two-lane 32-hex opaque hash over the private identity plus bounded event facts. The function returns only hex and never the input string:

```ts
function opaqueFingerprint(parts: Array<string | number>): string {
  const value = parts.join('\u001f')
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193) >>> 0
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0
  }
  const lane = (seed: number) => seed.toString(16).padStart(8, '0')
  return `${lane(left)}${lane(right)}${lane(left ^ right)}${lane(Math.imul(left, right))}`
}
```

For sessions, evaluate terminal lifecycle first, then blocking/warning, then fresh/stale activity. For tasks, evaluate exact status sets; unknown statuses close rather than clutter the desk.

- [x] **Step 4: Refactor `WorkDesk` to live buckets only**

Change the types and builder:

```ts
export type WorkItemBucket = 'attention' | 'active'
export type WorkDesk = { attention: WorkItem[]; active: WorkItem[] }

export function emptyWorkDesk(): WorkDesk {
  return { attention: [], active: [] }
}

const disposition = projectSessionDisposition(session, now)
if (disposition.kind === 'closed') return null
```

Add `fingerprint?: string` and `attentionKind?: 'failed' | 'timed_out' | 'detached' | 'transport_lost' | 'stale' | 'blocked'` to `WorkItem`; require both for attention items. Map task statuses directly, map stale sessions to `stale`, and map verification/warning sessions to `blocked`. Filter null items, sort attention by tone severity then `updatedAt`, and active by `updatedAt`. Change `buildWorkDesk(snapshot, tasks, now = Date.now())` so stale tests use a fixed clock.

- [x] **Step 5: Update model tests to prove terminal work disappears**

Replace completed-bucket assertions with:

```ts
expect(desk).toEqual(expect.objectContaining({ attention: expect.any(Array), active: expect.any(Array) }))
expect('completed' in desk).toBe(false)
expect([...desk.attention, ...desk.active].map((item) => item.target.id)).not.toContain('task-succeeded')
expect([...desk.attention, ...desk.active].map((item) => item.target.id)).not.toContain('session-stopped')
```

- [x] **Step 6: Run focused desktop tests and typecheck**

Run: `cd desktop && npm test -- --run src/components/work/workLifecycleProjection.test.ts src/components/work/workItemModel.test.ts && npm run typecheck`

Expected: all tests pass and TypeScript exits 0.

- [x] **Step 7: Commit the pure model slice**

```bash
git add desktop/src/components/work/workLifecycleProjection.ts desktop/src/components/work/workLifecycleProjection.test.ts desktop/src/components/work/workItemModel.ts desktop/src/components/work/workItemModel.test.ts
git commit -m "feat: project only live current work"
```

### Task 3: Persist safe work acknowledgements in Electron main

**Files:**
- Create: `desktop/electron/services/work-attention-ledger.ts`
- Create: `desktop/electron/services/work-attention-ledger.test.ts`
- Modify: `desktop/electron/ipc/channels.ts`
- Modify: `desktop/electron/ipc/capabilities.ts`
- Modify: `desktop/electron/ipc/capabilities.test.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/src/lib/desktopHost/index.ts`

- [x] **Step 1: Write ledger RED tests**

Use a temporary directory and inject `readFile`, `writeFile`, `rename`, and `now`. Assert:

```ts
const ledger = createWorkAttentionLedger({ userDataDir, now: () => NOW })
await ledger.resolve('0123456789abcdef0123456789abcdef', 'acknowledged')
expect(await ledger.resolved(['0123456789abcdef0123456789abcdef'])).toEqual([
  '0123456789abcdef0123456789abcdef'
])

const persisted = await readJson(ledgerPath)
expect(persisted.entries[0].fingerprint).toMatch(/^[a-f0-9]{64}$/)
expect(JSON.stringify(persisted)).not.toContain('0123456789abcdef0123456789abcdef')
```

Add cases for 2,001 inserts pruning to 2,000, entries older than 90 days pruning, and malformed JSON being renamed to `work-attention-ledger.corrupt-<timestamp>.json` before starting empty.

- [x] **Step 2: Run the ledger test and confirm RED**

Run: `cd desktop && npm test -- --run electron/services/work-attention-ledger.test.ts`

Expected: FAIL because the service does not exist.

- [x] **Step 3: Implement atomic SHA-256 storage**

Use this public API:

```ts
export type WorkResolution = 'acknowledged' | 'promoted'

export type WorkAttentionLedger = {
  resolved(fingerprints: string[]): Promise<string[]>
  resolve(fingerprint: string, resolution: WorkResolution, taskIdentifier?: string): Promise<void>
}

export function createWorkAttentionLedger(options: {
  userDataDir: string
  now?: () => number
}): WorkAttentionLedger
```

Validate renderer fingerprints with `/^[a-f0-9]{32,128}$/`, hash them with `createHash('sha256')`, and persist only:

```ts
type StoredEntry = {
  fingerprint: string
  resolution: WorkResolution
  resolvedAt: number
  taskIdentifier?: string
}
```

Write mode `0o600` to a sibling `.tmp`, then `rename` over the ledger. Bound `taskIdentifier` to the Taskboard identifier pattern and never store titles, IDs, paths, prompts, or error text.

- [x] **Step 4: Add exact IPC capability tests**

Add channels `workAttentionResolved` and `workAttentionResolve`. Accept only:

```ts
{ fingerprints: ['32-or-more-lowercase-hex'] }
{ fingerprint: '32-or-more-lowercase-hex', resolution: 'acknowledged' }
{ fingerprint: '32-or-more-lowercase-hex', resolution: 'promoted', taskIdentifier: 'DAOFLOW-123' }
```

Reject extra keys, more than 200 fingerprints, raw paths, raw session/job IDs, and invalid resolutions.

- [x] **Step 5: Wire preload, typed host, and main handlers**

Expose:

```ts
getResolvedWork(fingerprints: string[]): Promise<string[]>
resolveWork(
  fingerprint: string,
  resolution: WorkResolution,
  taskIdentifier?: string
): Promise<void>
```

Create the ledger lazily with `app.getPath('userData')`; register handlers through the existing trusted-window `registerHandler` wrapper.

- [x] **Step 6: Run ledger, IPC, and type tests**

Run: `cd desktop && npm test -- --run electron/services/work-attention-ledger.test.ts electron/ipc/capabilities.test.ts && npm run typecheck`

Expected: all pass.

- [x] **Step 7: Commit the acknowledgement boundary**

```bash
git add desktop/electron/services/work-attention-ledger.ts desktop/electron/services/work-attention-ledger.test.ts desktop/electron/ipc/channels.ts desktop/electron/ipc/capabilities.ts desktop/electron/ipc/capabilities.test.ts desktop/electron/preload.ts desktop/electron/main.ts desktop/src/lib/desktopHost/index.ts
git commit -m "feat: add safe work attention ledger"
```

### Task 4: Add the local Taskboard read adapter

**Files:**
- Create: `desktop/electron/services/taskboard-local.ts`
- Create: `desktop/electron/services/taskboard-local.test.ts`
- Modify: `desktop/electron/ipc/channels.ts`
- Modify: `desktop/electron/ipc/capabilities.ts`
- Modify: `desktop/electron/ipc/capabilities.test.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/src/lib/desktopHost/index.ts`

- [x] **Step 1: Write launcher and safe projection RED tests**

Inject `readFile`, `writeFile`, and `fetch`. Cover:

```ts
expect(parseLauncher({ version: 1, url: 'http://127.0.0.1:47823/challenge' })).toBeTruthy()
for (const url of [
  'https://127.0.0.1/challenge',
  'http://example.com/challenge',
  'http://user:pass@127.0.0.1/challenge',
  'http://127.0.0.1/challenge?token=x',
  'http://127.0.0.1/challenge#token'
]) expect(() => parseLauncher({ version: 1, url })).toThrow()
```

Mock `/api/projects` with one project whose `workspacePath` equals the descriptor workspace root and `/api/tasks?projectId=dao-flow&archived=false`. Assert only `blocked`, `in_progress`, and `in_review` survive, sorted in that order, and the renderer projection contains only `identifier`, safe `title`, `status`, `priority`, and `updatedAt`.

- [x] **Step 2: Run the adapter test and confirm RED**

Run: `cd desktop && npm test -- --run electron/services/taskboard-local.test.ts`

Expected: FAIL because the adapter does not exist.

- [x] **Step 3: Implement private descriptor discovery**

Use this service contract:

```ts
export type TaskboardWorkItem = {
  identifier: string
  title: string
  status: 'blocked' | 'in_progress' | 'in_review'
  priority: 'none' | 'urgent' | 'high' | 'medium' | 'low'
  updatedAt: number
}

export type TaskboardSnapshot = {
  state: 'connected' | 'disconnected' | 'unmapped'
  writable: boolean
  message: string
  items: TaskboardWorkItem[]
}
```

Discovery order is `CODEX_TASKBOARD_RUNTIME_FILE`, private config `taskboard-connector.json`, then `<runtimeRoot>/.taskboard-data/launcher-runtime.json` in development. Store only the selected descriptor path in the `0o600` main-process config; never return it.

Parse the descriptor, require `http:`, hostname `127.0.0.1` or `localhost`, nonempty challenge path, and empty username/password/search/hash. Resolve only fixed relative API paths against the challenge base.

- [x] **Step 4: Implement exact read behavior**

Send `accept: application/json` and `x-taskboard-client: dao-flow-desktop`. Match the project by comparing the real descriptor workspace root (`dirname(dirname(descriptorPath))`) with `project.workspacePath` inside the main process. If unmatched, return `unmapped` and zero items. Never project project IDs, task UUIDs, workspace paths, thread IDs, descriptions, comments, or challenge tokens.

- [x] **Step 5: Add connect and snapshot IPC methods**

Add channels `taskboardSnapshot` and `taskboardConnect`; both require `undefined` payload. `taskboardConnect` opens a system file picker restricted to JSON, rejects any selected filename other than `launcher-runtime.json`, validates it before saving, and returns the same safe snapshot type.

Expose through `DesktopHost`:

```ts
getTaskboardSnapshot(): Promise<TaskboardSnapshot>
connectTaskboard(): Promise<TaskboardSnapshot>
```

- [x] **Step 6: Run adapter, IPC, and type tests**

Run: `cd desktop && npm test -- --run electron/services/taskboard-local.test.ts electron/ipc/capabilities.test.ts && npm run typecheck`

Expected: all pass.

- [x] **Step 7: Commit the read-only connector**

```bash
git add desktop/electron/services/taskboard-local.ts desktop/electron/services/taskboard-local.test.ts desktop/electron/ipc/channels.ts desktop/electron/ipc/capabilities.ts desktop/electron/ipc/capabilities.test.ts desktop/electron/preload.ts desktop/electron/main.ts desktop/src/lib/desktopHost/index.ts
git commit -m "feat: read local Taskboard work safely"
```

### Task 5: Render acknowledgements and plan/review work

**Files:**
- Create: `desktop/src/components/control/TaskboardWorkPanel.tsx`
- Create: `desktop/src/components/control/TaskboardWorkPanel.test.tsx`
- Modify: `desktop/src/components/control/CurrentWorkControlView.tsx`
- Modify: `desktop/src/components/control/CurrentWorkControlView.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write the Current Work RED integration tests**

Assert the user-visible lifecycle:

```tsx
expect(screen.queryByRole('heading', { name: '最近完成' })).not.toBeInTheDocument()
expect(screen.queryByText('成功任务')).not.toBeInTheDocument()
expect(screen.queryByText('已停止会话')).not.toBeInTheDocument()
expect(screen.getByText('运行中 1')).toBeInTheDocument()
expect(screen.getByText('待处理 1')).toBeInTheDocument()
expect(screen.getByText('计划事项 2')).toBeInTheDocument()
```

Select a failed item, click `我知道了`, assert `resolveWork(fingerprint, 'acknowledged')`, and assert the card leaves the DOM. Return a new failure with a new timestamp/fingerprint and assert it reappears.

- [x] **Step 2: Write `TaskboardWorkPanel` RED tests**

Cover connected sorting, disconnected recovery, and unmapped state:

```tsx
render(<TaskboardWorkPanel snapshot={snapshot} loading={false} onConnect={onConnect} />)
expect(screen.getAllByRole('article').map((node) => node.textContent)).toEqual([
  expect.stringContaining('阻塞事项'),
  expect.stringContaining('进行事项'),
  expect.stringContaining('待验收事项')
])

render(<TaskboardWorkPanel snapshot={disconnected} loading={false} onConnect={onConnect} />)
await user.click(screen.getByRole('button', { name: '连接本地 Taskboard' }))
expect(onConnect).toHaveBeenCalledTimes(1)
```

- [x] **Step 3: Run focused tests and confirm RED**

Run: `cd desktop && npm test -- --run src/components/control/TaskboardWorkPanel.test.tsx src/components/control/CurrentWorkControlView.test.tsx`

Expected: FAIL because the panel/actions and live-only layout are absent.

- [x] **Step 4: Implement the read-only plan/review panel**

Render status labels `阻塞`, `进行中`, `待验收`, bounded titles, priority, and relative update age. The component receives only `TaskboardSnapshot`, `loading`, `onRefresh`, and `onConnect`; it performs no fetch and stores no ID.

- [x] **Step 5: Compose three desk sections and explicit actions**

In `CurrentWorkControlView`:

1. Refresh HUD/tasks every 3 seconds as today.
2. Refresh Taskboard independently every 15 seconds; a Taskboard error must not replace the live desk error.
3. Query `getResolvedWork` for attention fingerprints and filter resolved cards.
4. Render counters and only `需要我处理`, `正在运行`, `计划与验收`.
5. Add `我知道了`, `加入任务板`, and `查看历史` to the selected attention detail; show only `查看历史` for running work.
6. Guard live, acknowledgement, Taskboard, and selection requests with independent sequence refs.

Use the exact empty labels:

```ts
const EMPTY_LABELS = {
  attention: '目前没有需要你处理的异常。',
  active: '目前没有 Agent 正在运行。'
}
```

- [x] **Step 6: Add scoped presentation**

Add only `.work-desk-summary`, `.work-item-actions`, `.taskboard-work-*`, and responsive descendants. Reuse defined theme tokens `--border`, `--surface-low`, `--ink-muted`; do not introduce undefined variables.

- [x] **Step 7: Run focused tests, typecheck, and lint**

Run: `cd desktop && npm test -- --run src/components/control/TaskboardWorkPanel.test.tsx src/components/control/CurrentWorkControlView.test.tsx src/components/work/workItemModel.test.ts && npm run typecheck && npx eslint --quiet src/components/control/TaskboardWorkPanel.tsx src/components/control/CurrentWorkControlView.tsx`

Expected: all pass.

- [x] **Step 8: Commit the live desk UI**

```bash
git add desktop/src/components/control/TaskboardWorkPanel.tsx desktop/src/components/control/TaskboardWorkPanel.test.tsx desktop/src/components/control/CurrentWorkControlView.tsx desktop/src/components/control/CurrentWorkControlView.test.tsx desktop/src/theme/globals.css
git commit -m "feat: add quiet current work desk"
```

### Task 6: Add safely attributed Taskboard promotion

**Files:**
- Modify: `desktop/electron/services/taskboard-local.ts`
- Modify: `desktop/electron/services/taskboard-local.test.ts`
- Modify: `desktop/electron/ipc/channels.ts`
- Modify: `desktop/electron/ipc/capabilities.ts`
- Modify: `desktop/electron/ipc/capabilities.test.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/src/lib/desktopHost/index.ts`
- Create: `desktop/src/components/control/PromoteWorkDialog.tsx`
- Create: `desktop/src/components/control/PromoteWorkDialog.test.tsx`
- Modify: `desktop/src/components/control/CurrentWorkControlView.tsx`
- Modify: `desktop/src/components/control/CurrentWorkControlView.test.tsx`

- [x] **Step 1: Write zero-write and attributed-write adapter tests**

Without `CODEX_THREAD_ID`:

```ts
const adapter = createTaskboardLocalAdapter({ environment: {}, fetch: fetchSpy, ...deps })
await expect(adapter.create(safeDraft)).rejects.toMatchObject({ code: 'ATTRIBUTION_REQUIRED' })
expect(fetchSpy).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'POST' }))
```

With a valid current thread ID, assert one POST to the fixed `/api/tasks` URL and exact body:

```ts
expect(JSON.parse(String(post.init?.body))).toEqual({
  projectId: 'dao-flow',
  title: 'Dao Flow 异常需要处理',
  description: '来源：任务\n异常：连接中断\n验收：确认连接恢复并完成一次验证。\n工作区：dao-proxy-pro',
  status: 'todo',
  priority: 'medium',
  labels: ['dao-flow', 'work-desk'],
  threadId: '019fe1df-629c-7ed1-9035-92c56fe39520'
})
```

Assert malicious prompt, Authorization, command, raw IDs, and path fields are rejected as extra keys before fetch.

- [x] **Step 2: Write dialog RED tests**

```tsx
render(<PromoteWorkDialog open draft={safeDraft} writable={false} onConfirm={onConfirm} />)
expect(screen.getByRole('button', { name: '确认加入任务板' })).toBeDisabled()
expect(screen.getByText('需要从当前 Codex 任务发起')).toBeInTheDocument()
expect(onConfirm).not.toHaveBeenCalled()
```

For `writable={true}`, assert opening causes zero calls, cancel causes zero calls, and only explicit confirmation calls `onConfirm` once.

- [x] **Step 3: Run adapter/dialog tests and confirm RED**

Run: `cd desktop && npm test -- --run electron/services/taskboard-local.test.ts src/components/control/PromoteWorkDialog.test.tsx`

Expected: FAIL because creation and the dialog do not exist.

- [x] **Step 4: Implement the white-listed creation draft**

Use an exact renderer payload with no extensible record:

```ts
export type PromoteWorkDraft = {
  fingerprint: string
  title: string
  sourceKind: 'session' | 'task'
  failureKind: 'failed' | 'timed_out' | 'detached' | 'transport_lost' | 'stale' | 'blocked'
  acceptance: string
}
```

Validate lengths, enum values, and shared secret/path sanitizer output. Derive workspace display name in main from the mapped workspace; never accept it from renderer. Build the exact `todo` / `medium` request and add the real `process.env.CODEX_THREAD_ID` only when it matches the bounded Codex ID pattern. Return only `{ identifier, title, status, priority, updatedAt }`.

- [x] **Step 5: Add create IPC and dialog flow**

Add `taskboardCreate` and `DesktopHost.createTaskboardWork(draft)`. On success:

1. Call `resolveWork(fingerprint, 'promoted', identifier)`.
2. Remove the attention item locally.
3. Refresh Taskboard.
4. Close the dialog and announce success.

On failure, keep the card and dialog draft, show a recoverable status, and do not resolve the fingerprint.

- [x] **Step 6: Prove no implicit writes in Current Work tests**

Assert initial render, polling, selection, opening dialog, cancel, Taskboard refresh, and profile/advisory refresh produce zero `createTaskboardWork` calls. Only `确认加入任务板` may produce one call.

- [x] **Step 7: Run focused, full desktop, type, and lint checks**

Run: `cd desktop && npm test -- --run electron/services/taskboard-local.test.ts electron/ipc/capabilities.test.ts src/components/control/PromoteWorkDialog.test.tsx src/components/control/CurrentWorkControlView.test.tsx && npm test && npm run typecheck && npm run lint`

Expected: focused and full Vitest pass, typecheck exits 0, lint has zero errors.

- [x] **Step 8: Commit the explicit promotion flow**

```bash
git add desktop/electron/services/taskboard-local.ts desktop/electron/services/taskboard-local.test.ts desktop/electron/ipc/channels.ts desktop/electron/ipc/capabilities.ts desktop/electron/ipc/capabilities.test.ts desktop/electron/preload.ts desktop/electron/main.ts desktop/src/lib/desktopHost/index.ts desktop/src/components/control/PromoteWorkDialog.tsx desktop/src/components/control/PromoteWorkDialog.test.tsx desktop/src/components/control/CurrentWorkControlView.tsx desktop/src/components/control/CurrentWorkControlView.test.tsx
git commit -m "feat: promote work with explicit attribution"
```

### Task 7: Document, package, and verify the installed macOS App

**Files:**
- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`
- Modify: `docs/superpowers/specs/2026-08-10-dao-current-work-taskboard-lifecycle-design.md`
- Modify: `docs/superpowers/plans/2026-08-10-dao-current-work-taskboard-lifecycle.md`

- [x] **Step 1: Update user-facing boundaries**

Document these exact outcomes:

- `当前工作` is transient and excludes terminal sessions/tasks.
- `协作会话` and `任务进度` retain history.
- `我知道了` stores only a SHA-256 resolution ledger.
- Taskboard reads only a chosen local loopback launcher and never auto-creates/updates/closes work.
- Promotion requires preview, explicit confirmation, and a real current Codex thread attribution; Finder-launched un-attributed Apps remain read-only.
- No provider/model priority changes, prompt/Auth/path/ID persistence, or new remote capability.

- [x] **Step 2: Run the complete verification matrix**

Run:

```bash
node test/web-hud-projection.test.js
node test/web-hud-service.test.js
npm test
cd desktop
npm test
npm run typecheck
npm run lint
npm run build
npm run build:electron
npm run pack:mac
```

Expected: every command exits 0; lint has zero errors; electron-builder produces an arm64 `.app` under `desktop/release/mac-arm64/` or the configured release directory.

- [x] **Step 3: Check formatting and unintended scope**

Run:

```bash
git diff --check
git diff --name-only 87f6905..HEAD
git status --short
rg -n "T[B]D|implement later|Authorization:|Bearer |/Users/|/home/|/root/" \
  desktop/src/components/work desktop/src/components/control \
  desktop/electron/services/work-attention-ledger.ts \
  desktop/electron/services/taskboard-local.ts
```

Expected: diff check is clean; the commit range contains only planned files; the source scan finds test fixtures or sanitizer patterns only, never shipped secrets/paths or placeholders.

- [x] **Step 4: Install and configure the local App safely**

Quit the existing Dao Flow process, copy the newly packaged `Dao Flow.app` to `/Applications/Dao Flow.app`, preserve the desktop alias, and launch it. Use the in-app file picker once to select `/Users/a77/dao-proxy-pro/.taskboard-data/launcher-runtime.json`; verify the full path never appears in renderer text.

- [x] **Step 5: Perform visible App acceptance**

Verify in the running App:

1. `当前工作` is the default desk.
2. No `最近完成` section appears.
3. The 228-hour stale hydrated session is not presented as healthy active work.
4. Terminal sessions and succeeded/cancelled tasks are absent from the desk but remain in history views.
5. `计划与验收` shows current DAOFLOW open work or a clear local/offline/unmapped state.
6. `我知道了` removes an attention item and it remains absent after relaunch.
7. Without Finder process attribution, promotion preview is visible but confirmation is disabled with the attribution explanation.
8. Route priority/provider/model configuration is unchanged.

- [x] **Step 6: Mark plan/spec implemented and commit docs**

Change the spec status to `已实现并验收`, tick completed plan checkboxes, then:

```bash
git add desktop/README.md docs/DAO_DESKTOP_PARITY.md docs/superpowers/specs/2026-08-10-dao-current-work-taskboard-lifecycle-design.md docs/superpowers/plans/2026-08-10-dao-current-work-taskboard-lifecycle.md
git commit -m "docs: complete current work lifecycle acceptance"
```

- [x] **Step 7: Sync DAOFLOW-7 to review, never done**

Read the issue and comments again. Add a Taskboard comment containing commit range, test/build/package results, installed App verification, and the known write-attribution boundary. Read the issue once more and move it to `in_review` using the latest version. Do not move it to `done` without explicit user acceptance.

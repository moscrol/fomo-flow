# Dao Flow Communication Control Desk Implementation Plan

> **Execution record:** Implemented and verified on 2026-08-11. DAOFLOW-7 records the
> focused/full Desktop tests, arm64 package inspection, installed-app check, and `in_review` handoff.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dao Flow explicitly distinguish source channels from upstream routes and expose a safe, evidence-based capability matrix for Codex, Devin, ACP, and IDE ingress.

**Architecture:** Add one renderer-owned pure projection for source capabilities, render it as an unframed list in the existing ACP workbench, and clarify source/upstream labels in the existing Work Capsule and Agent roster. Reuse `workItemModel`, `deskEventModel`, and the existing five-minute lifecycle projection; do not add endpoints, persistence, remote execution, or route writes.

**Tech Stack:** TypeScript, React 18, Vitest, Testing Library, existing Dao collaboration models and control primitives.

---

### Task 1: Project Source Capabilities From Existing Safe Facts

**Files:**
- Create: `desktop/src/components/collaboration/channelCapabilityModel.ts`
- Create: `desktop/src/components/collaboration/channelCapabilityModel.test.ts`

- [x] **Step 1: Write the failing capability projection tests**

Cover four facts in `channelCapabilityModel.test.ts`:

```ts
const capabilities = projectChannelCapabilities(snapshot, tasks)

expect(capabilities.find((item) => item.source === 'codex')).toMatchObject({
  observability: 'available',
  send: 'unavailable',
  approval: 'unavailable',
  handoff: 'available'
})
expect(capabilities.find((item) => item.source === 'devin')).toMatchObject({
  protocol: 'acp',
  send: 'available',
  approval: 'available'
})
expect(capabilities.find((item) => item.source === 'ide')?.observability).toBe('unknown')
expect(JSON.stringify(capabilities)).not.toMatch(/private-session|private-job|\/Users\//)
```

The Devin fixture must contain an active `mode: 'acp-host'`, `identityKind: 'native'` session. An external Devin fixture must remain read-only.

- [x] **Step 2: Run the test and verify the model is missing**

Run:

```bash
cd desktop
npx vitest run src/components/collaboration/channelCapabilityModel.test.ts --maxWorkers=1
```

Expected: FAIL because `projectChannelCapabilities` does not exist.

- [x] **Step 3: Implement the pure projection**

Define these public types in `channelCapabilityModel.ts`:

```ts
export type ChannelCapabilityState = 'available' | 'unavailable' | 'unknown'
export type CommunicationSource = 'acp' | 'codex' | 'devin' | 'ide'

export type ChannelCapability = {
  source: CommunicationSource
  label: string
  protocol: 'acp' | 'unknown'
  observability: ChannelCapabilityState
  send: ChannelCapabilityState
  approval: ChannelCapabilityState
  handoff: ChannelCapabilityState
  reason: string
  lastSeenAt: number
}
```

Implement:

```ts
export function projectChannelCapabilities(
  snapshot: CollaborationSnapshot,
  tasks: CollaborationTask[]
): ChannelCapability[]
```

Rules:

- A source is observed only when an existing session, request, or task reports it.
- A native `devin` session with `mode === 'acp-host'` is the only source allowed to report `send` and `approval` as available.
- Observed external Codex, Devin, ACP, and IDE facts are read-only; handoff is available because existing safe handoff components can represent observed sessions/tasks.
- Unseen sources report `unknown`, not success.
- The projection stores no IDs, workspace, prompt, path, provider credentials, or message content.

- [x] **Step 4: Run the model test**

Run the same focused Vitest command. Expected: PASS.

### Task 2: Render the Capability Matrix in ACP Collaboration

**Files:**
- Create: `desktop/src/components/collaboration/ChannelCapabilityPanel.tsx`
- Create: `desktop/src/components/collaboration/ChannelCapabilityPanel.test.tsx`
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.tsx`
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: Write the failing component tests**

Render a projection containing observed Codex, hosted Devin, and unseen IDE facts. Assert:

```tsx
expect(screen.getByRole('region', { name: '入口能力' })).toBeInTheDocument()
expect(screen.getByText('Devin')).toBeInTheDocument()
expect(screen.getByText('ACP 托管')).toBeInTheDocument()
expect(screen.getAllByText('只读').length).toBeGreaterThan(0)
expect(screen.getByText('未观测')).toBeInTheDocument()
```

Extend the ACP workbench integration fixture and assert that the page renders `入口能力` without making any request beyond the existing HUD and task GETs.

- [x] **Step 2: Run the component tests and verify RED**

Run:

```bash
npx vitest run \
  src/components/collaboration/ChannelCapabilityPanel.test.tsx \
  src/components/control/AcpWorkbenchControlView.test.tsx \
  --maxWorkers=1
```

Expected: FAIL because the panel is missing.

- [x] **Step 3: Implement the panel and integration**

`ChannelCapabilityPanel` receives `capabilities: ChannelCapability[]` and renders one unframed row per source. Each row must show:

```text
来源名称 · 协议
观测 / 发送 / 审批 / 交接
安全原因
```

Use plain labels:

```ts
available -> 可用
unavailable -> 只读 or 不支持, depending on capability
unknown -> 未观测
```

In `AcpWorkbenchControlView`, compute the projection with `useMemo` from the already loaded `snapshot` and `tasks`, then render the panel after `Agent 名册`. Do not add another fetch.

- [x] **Step 4: Add restrained list styling**

Add stable responsive rows in `globals.css` using a source column, four capability columns, and a reason column. Do not create nested cards. At narrow widths, collapse each row to two columns without changing content order.

- [x] **Step 5: Run focused UI tests**

Run the Task 2 command. Expected: PASS.

### Task 3: Clarify Source Channel and Upstream Route Language

**Files:**
- Modify: `desktop/src/components/control/WorkCapsulePanel.tsx`
- Modify: `desktop/src/components/control/WorkCapsulePanel.test.tsx`
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.tsx`
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.test.tsx`

- [x] **Step 1: Write the failing copy assertions**

Update tests to require:

```ts
expect(screen.getByText('来源 · DEVIN')).toBeInTheDocument()
expect(screen.getByText('上游渠道 cccc · 上游模型 gpt-5.6')).toBeInTheDocument()
expect(screen.getByText('路由配置名 swe-1-6')).toBeInTheDocument()
```

For the ACP roster, require `上游模型 gpt-5.6 · 上游渠道 cccc`.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run \
  src/components/control/WorkCapsulePanel.test.tsx \
  src/components/control/AcpWorkbenchControlView.test.tsx \
  --maxWorkers=1
```

Expected: FAIL on the old ambiguous labels.

- [x] **Step 3: Apply the plain-language labels**

Change only presentation strings:

```tsx
<span>{`来源 · ${item.source}`}</span>
<dd>{`上游渠道 ${provider} · 上游模型 ${model}`}</dd>
<dd>{`路由配置名 ${routeName}`}</dd>
```

Keep provider/model/priority values unchanged.

- [x] **Step 4: Run focused tests**

Run the Task 3 command. Expected: PASS.

### Task 4: Validate, Package, and Inspect the Real App

**Files:**
- Modify: `desktop/README.md`
- Modify: `docs/superpowers/specs/2026-08-12-dao-communication-control-desk-design.md`

- [x] **Step 1: Document the capability boundary**

Add a short Desktop README paragraph explaining that source channels and upstream routes are different axes, and that capability states describe current safe facts rather than granting permissions.

- [x] **Step 2: Run formatting and focused tests**

Run Prettier on touched files and all tests from Tasks 1-3. Expected: PASS.

- [x] **Step 3: Run complete Desktop verification**

Run:

```bash
cd desktop
npx vitest run --maxWorkers=1
npm run typecheck
npm run lint
npm run build
npm run pack:mac
```

Expected: all commands exit 0.

- [x] **Step 4: Install and inspect the packaged app**

Preserve the current installed app as a timestamped backup, install the new arm64 package, and open ACP Collaboration. Verify:

- `入口能力` lists Codex, Devin, ACP, and IDE without exposing IDs or paths.
- Hosted Devin is the only source that can show send/approval as available.
- Agent roster and Work Capsule clearly separate source from upstream route.
- Existing route priority and model selection remain unchanged.
- Dao runtime and Taskboard health endpoints remain alive.

- [x] **Step 5: Sync Taskboard**

Comment DAOFLOW-7 with the changed components, verification commands, packaged-app result, and residual risks. Read the latest issue version and move it to `in_review`; do not mark it done.

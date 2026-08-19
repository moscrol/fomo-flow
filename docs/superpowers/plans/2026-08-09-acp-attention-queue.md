# ACP 会话接手队列 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ACP Workbench 中增加一个由安全 session projection 驱动的只读人工接手队列。

**Architecture:** `collaborationAttention.ts` 只负责把标准化会话变成有序关注项；`CollaborationAttentionQueue` 只负责渲染和回调选择；ACP 页面将选择回调映射到现有 `surfaceFilter`/`selectedId` 状态。没有新的网络或写操作。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Vite、Electron/Bun。

---

### Task 1: 实现关注项模型与优先级测试

**Files:**
- Create: `desktop/src/components/collaboration/collaborationAttention.ts`
- Create: `desktop/src/components/collaboration/collaborationAttention.test.ts`

- [ ] **Step 1: 写优先级和上限失败测试**

用 `normalizeCollaborationSnapshot` 构造五个会话：验证阻塞、失败工具、stale、请求在途、健康非在途。断言输出顺序依次为 `blocked`、`failed`、`stale`、`watch`，健康非在途会话不进入队列；再构造 20 个 stale 会话，断言长度最多 12，且同级按 `latestActivityAt` 倒序。

- [ ] **Step 2: 运行测试确认失败**

```bash
./node_modules/.bin/vitest run src/components/collaboration/collaborationAttention.test.ts
```

预期：因模型文件不存在而失败。

- [ ] **Step 3: 写最小类型和构建器**

导出：

```ts
export type CollaborationAttentionKind = 'blocked' | 'failed' | 'stale' | 'watch'
export type CollaborationAttentionItem = {
  sessionId: string
  kind: CollaborationAttentionKind
  title: string
  detail: string
  suggestion: string
  tone: 'good' | 'warn' | 'bad' | 'muted' | 'brand'
  priority: number
  at: number
}

export function buildCollaborationAttention(
  sessions: CollaborationSession[],
  now: number
): CollaborationAttentionItem[]
```

每个会话最多生成一项。选择逻辑严格按 spec 的四级优先级；`detail` 只使用已标准化的 goal/phase/relative age，`suggestion` 为固定中文文案。排序使用 `priority DESC`、`at DESC`、`sessionId` 稳定兜底，最后 `.slice(0, 12)`。

- [ ] **Step 4: 运行模型测试确认通过**

重复 Step 2 命令，预期优先级、同级排序、上限和健康空队列断言全部通过。

- [ ] **Step 5: 提交模型切片**

```bash
git add desktop/src/components/collaboration/collaborationAttention.ts desktop/src/components/collaboration/collaborationAttention.test.ts
git commit -m "feat: build ACP attention queue model"
```

### Task 2: 创建无状态队列组件与交互测试

**Files:**
- Create: `desktop/src/components/collaboration/CollaborationAttentionQueue.tsx`
- Create: `desktop/src/components/collaboration/CollaborationAttentionQueue.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [ ] **Step 1: 写组件失败测试**

渲染两个标准化会话和 `onSelectSession` spy，断言出现 `人工接手队列`、优先级文案、目标和建议；点击 `查看会话：<goal>` 后断言回调收到隐藏的 session ID。另测空 sessions 时出现 `当前没有需要人工接手的会话。`。

- [ ] **Step 2: 运行测试确认失败**

```bash
./node_modules/.bin/vitest run src/components/collaboration/CollaborationAttentionQueue.test.tsx
```

预期：因组件文件不存在而失败。

- [ ] **Step 3: 实现组件**

组件签名：

```tsx
export function CollaborationAttentionQueue({
  sessions,
  now,
  selectedSessionId,
  onSelectSession
}: {
  sessions: CollaborationSession[]
  now: number
  selectedSessionId: string
  onSelectSession(sessionId: string): void
})
```

调用 `buildCollaborationAttention`，渲染 `section[aria-label="人工接手队列"]`。每项用 button，`aria-label` 只包含安全 title，不包含 session ID；选中项用 `aria-current`。kind 映射为“验证阻塞 / 失败信号 / 失联观察 / 在途观察”。

- [ ] **Step 4: 添加最小样式**

在 `globals.css` 增加队列标题、列表、优先级圆点、建议文案和选中态样式；复用现有 `collaboration-session-row` 的边框/颜色变量，移动端改为单列，不改变其他组件。

- [ ] **Step 5: 运行组件测试确认通过**

重复 Step 2 命令，预期两个测试通过。

- [ ] **Step 6: 提交组件切片**

```bash
git add desktop/src/components/collaboration/CollaborationAttentionQueue.tsx desktop/src/components/collaboration/CollaborationAttentionQueue.test.tsx desktop/src/theme/globals.css
git commit -m "feat: add ACP attention queue view"
```

### Task 3: 接入 ACP Workbench 并完成验证

**Files:**
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.tsx`
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.test.tsx`

- [ ] **Step 1: 接入队列并映射选择动作**

在来源筛选条之后、会话 split grid 之前挂载：

```tsx
<CollaborationAttentionQueue
  now={now}
  onSelectSession={(id) => {
    setSurfaceFilter('all')
    setSelectedId(id)
  }}
  selectedSessionId={selected?.id ?? ''}
  sessions={snapshot.sessions}
/>
```

不增加新的 `useEffect` 或 API 请求。

- [ ] **Step 2: 扩展 ACP 集成测试**

在现有 fixture 增加 blocking、failed、stale 和 requestInFlight 会话，断言队列显示最高优先级条目；点击该条目后断言对应会话标题出现且 `全部` filter 的 `aria-pressed` 为 true。保留诊断、活动流、交接包和 CODEX 筛选断言。

- [ ] **Step 3: 运行完整桌面验证**

```bash
cd desktop
npm test
npm run typecheck
npm run lint
npm run build
npm run build:electron
cd ..
node --test test/dao-desktop-smoke.test.js
```

预期：所有命令退出码为 0，测试数量和构建产物均正常。

- [ ] **Step 4: 检查并提交本切片**

```bash
git diff --check
git status --short
git add desktop/src/components/collaboration/collaborationAttention.ts desktop/src/components/collaboration/collaborationAttention.test.ts desktop/src/components/collaboration/CollaborationAttentionQueue.tsx desktop/src/components/collaboration/CollaborationAttentionQueue.test.tsx desktop/src/components/control/AcpWorkbenchControlView.tsx desktop/src/components/control/AcpWorkbenchControlView.test.tsx desktop/src/theme/globals.css
git diff --cached --check
git commit -m "feat: complete ACP attention queue slice"
```

只允许暂存上述路径；其他代理、缓存、旧 Web、发行物和文档改动继续保持未暂存。

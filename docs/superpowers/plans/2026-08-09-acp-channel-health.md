# ACP 渠道健康矩阵 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ACP Workbench 中从现有 HUD projection 聚合并展示只读的全局渠道健康矩阵。

**Architecture:** 使用独立纯函数 `buildCollaborationChannelHealth` 合并 provider/session/request 三类安全投影，再由无副作用 React 组件呈现。页面只传入已有 snapshot，不增加 endpoint、IPC 或状态控制。

**Tech Stack:** React 18、TypeScript、Vitest、Testing Library、lucide-react、现有 Dao desktop CSS。

---

### Task 1: 渠道健康聚合模型

**Files:**
- Create: `desktop/src/components/collaboration/collaborationChannelHealth.ts`
- Test: `desktop/src/components/collaboration/collaborationChannelHealth.test.ts`

- [ ] **Step 1: Write the failing model test**

  用 `normalizeCollaborationSnapshot` 构造两个 provider、两个 session 和三条 request，断言返回 provider 并集、失败数优先、P95 保留，且 provider 名称包含 Bearer、`/Users/...` 或 `sk-...` 时被收敛。

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `./node_modules/.bin/vitest run src/components/collaboration/collaborationChannelHealth.test.ts`

  Expected: FAIL because `collaborationChannelHealth.ts` does not exist.

- [ ] **Step 3: Implement the pure builder**

  定义 `CollaborationChannelHealthItem`，以 providers、session route provider、request provider 的并集建立计数；`failureCount` 统计 `success === false` 或 `status` 为 error/failed 的 request；按 `failureCount desc`、`requestCount desc`、`provider asc` 排序并限制 12 项；所有可见文字经过长度限制和敏感文本收敛。

- [ ] **Step 4: Run the focused test and verify it passes**

  Run: `./node_modules/.bin/vitest run src/components/collaboration/collaborationChannelHealth.test.ts`

  Expected: PASS with all model assertions.

- [ ] **Step 5: Commit the model**

  ```bash
  git add desktop/src/components/collaboration/collaborationChannelHealth.ts desktop/src/components/collaboration/collaborationChannelHealth.test.ts
  git commit -m "feat: add ACP channel health model"
  ```

### Task 2: 渠道健康矩阵组件

**Files:**
- Create: `desktop/src/components/collaboration/CollaborationChannelHealthView.tsx`
- Test: `desktop/src/components/collaboration/CollaborationChannelHealthView.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- [ ] **Step 1: Write the failing component test**

  渲染一个 healthy provider 和一个 failed provider，断言区域名、渠道名、`TTFT P95`、`缓存未命中 P95`、失败摘要出现；断言原始 provider ID 不作为可访问文本出现；再用空数组断言“暂无渠道观测”。

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `./node_modules/.bin/vitest run src/components/collaboration/CollaborationChannelHealthView.test.tsx`

  Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the component and styles**

  组件接收 `providers`, `sessions`, `recentRequests`，用 `useMemo` 调用模型，输出 `section[aria-label="渠道健康矩阵"]`、`role=list` 和无按钮摘要卡；CSS 复用现有 tone 变量，并在窄屏下切为单列。

- [ ] **Step 4: Run the focused component test**

  Run: `./node_modules/.bin/vitest run src/components/collaboration/CollaborationChannelHealthView.test.tsx`

  Expected: PASS.

### Task 3: ACP Workbench 接入

**Files:**
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.tsx`
- Test: `desktop/src/components/control/AcpWorkbenchControlView.test.tsx`

- [ ] **Step 1: Extend the ACP fixture and assertions**

  在现有 provider fixture 中加入 hit/miss P95 已有值，断言 `渠道健康矩阵` 和 `bridge` 的 `720 ms` 展示；保持现有队列、交接包和来源筛选断言。

- [ ] **Step 2: Integrate without new data plumbing**

  在来源筛选条之后插入 `CollaborationChannelHealthView`，传入 `snapshot.providers`, `snapshot.sessions`, `snapshot.recentRequests`，不改变 refresh 或选中会话逻辑。

- [ ] **Step 3: Run focused ACP tests**

  Run: `./node_modules/.bin/vitest run src/components/collaboration/collaborationChannelHealth.test.ts src/components/collaboration/CollaborationChannelHealthView.test.tsx src/components/control/AcpWorkbenchControlView.test.tsx`

  Expected: PASS.

### Task 4: Full verification and taskboard handoff

- [ ] **Step 1: Run desktop tests and static checks**

  Run: `npm test`, `npm run typecheck`, `npm run lint` in `desktop/`.

- [ ] **Step 2: Build desktop and Electron artifacts**

  Run: `npm run build`, `npm run build:electron` in `desktop/`.

- [ ] **Step 3: Run root smoke and diff checks**

  Run: `node --test test/dao-desktop-smoke.test.js` and `git diff --check`.

- [ ] **Step 4: Commit only LOCAL-5 files**

  Stage the design/plan docs and the model/component/integration files; verify `git diff --cached --stat` contains no unrelated files; commit with `feat: add ACP channel health matrix`.

- [ ] **Step 5: Comment verification and move LOCAL-5 to in_review**

  Read `LOCAL-5`, add the commit and verification summary with `taskctl comment add`, read it again, then run `taskctl issue move LOCAL-5 --status in_review --if-version <latest>`. Do not move to done without explicit user acceptance.

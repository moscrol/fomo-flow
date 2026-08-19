# Dao Flow 控制桌质检修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复质检发现的 P0/P1/P2 问题，让当前工作详情、干预、产物和安全展示在真实 App 集成中可用。

**Architecture:** CurrentWork 保留选中项并在本页展开详情，显式导航动作才切换到既有详情页。安全展示字段由共享纯文本 sanitizer 投影，干预面板只消费安全数据和回调；所有 API 保持已有 GET。

**Tech Stack:** React, TypeScript, Vitest, Electron/Vite, existing `desktopHost` control API.

---

### Task 1: CurrentWork 集成详情可达性

**Files:**
- Modify: `desktop/src/components/control/CurrentWorkControlView.tsx`
- Modify: `desktop/src/components/control/CurrentWorkControlView.test.tsx`
- Modify: `desktop/src/App.test.tsx`

- [x] **Step 1: 写失败测试**

在当前工作测试中点击任务卡，断言“任务产物与终端事实”仍出现在当前工作 DOM；在 App 测试中断言点击卡片不会调用导航，点击“打开任务进度”才导航。

- [x] **Step 2: 运行 focused 测试确认失败**

运行 `cd desktop && npx vitest run src/components/control/CurrentWorkControlView.test.tsx src/App.test.tsx`，预期新增集成断言失败，因为当前卡片点击立即调用 `onOpenItem`。

- [x] **Step 3: 实现选中与显式导航分离**

将卡片回调改为只调用 `setSelectedItem`；详情面板接收 `onOpenItem` 和 item，渲染明确的“打开协作会话/打开任务进度”按钮并在按钮点击时导航。切换选中项时更新详情，不暴露 target ID。

- [x] **Step 4: 运行 focused 测试**

重复 focused Vitest，并运行 `npm run typecheck` 与 `npm run lint -- --quiet`，预期全部通过。

### Task 2: 安全干预契约与内存草稿

**Files:**
- Modify: `desktop/src/components/work/workItemModel.ts`
- Modify: `desktop/src/components/work/workItemInterventionModel.ts`
- Modify: `desktop/src/components/control/WorkItemInterventionPanel.tsx`
- Modify: `desktop/src/components/control/CurrentWorkControlView.tsx`
- Test: corresponding `*.test.ts(x)` files.

- [x] **Step 1: 写失败测试**

覆盖安全字段 `profile` 的默认值、advisory profile 文案、候选顺序内存草稿、无 POST/PUT/DELETE，以及面板只接收投影数据不自行读取 raw routing payload。

- [x] **Step 2: 运行 focused 测试确认失败**

运行 `cd desktop && npx vitest run src/components/work/workItemModel.test.ts src/components/work/workItemInterventionModel.test.ts src/components/control/WorkItemInterventionPanel.test.tsx`，预期新契约断言失败。

- [x] **Step 3: 实现安全投影与草稿**

在 CurrentWork 请求 existing advisory/handoff GET 并投影为安全 summary；WorkItemInterventionPanel 只显示 profile、候选和 React state 中的候选顺序草稿，提供“重置草稿”而不调用配置写入。详情导航回调保持显式。

- [x] **Step 4: 运行 focused 与类型检查**

运行上述 Vitest、`npm run typecheck`、`npm run lint -- --quiet` 和 `git diff --check`。

### Task 3: 统一脱敏、并行刷新和空态

**Files:**
- Create/modify: `desktop/src/components/work/displaySanitizer.ts`
- Modify: `desktop/src/components/work/workItemModel.ts`
- Modify: `desktop/src/components/work/workItemArtifactModel.ts`
- Modify: `desktop/src/components/control/CurrentWorkControlView.tsx`
- Modify: `desktop/src/theme/globals.css`
- Test: sanitizer/model/current-work tests.

- [x] **Step 1: 写失败测试**

覆盖 `/var`、`/etc`、`/opt`、`file://`、Windows 路径、`Authorization: Basic` 和 Bearer 的 DOM 脱敏；用 deferred requests 断言 HUD/tasks 并行；空态断言实时情况和接入渠道按钮。

- [x] **Step 2: 实现共享 sanitizer 与并行请求**

统一模型调用 sanitizer；用 `Promise.all` 发起 HUD/tasks，保留已有 sequence guard、tasks fallback 和 HUD 错误保留安全桌面数据；空态按钮调用既有导航回调。

- [x] **Step 3: 修复 CSS token**

为新增干预/产物样式使用已存在的 `--line`、`--surface`、`--text` 或提供 fallback，保持 scoped selectors。

- [x] **Step 4: 运行模型与视图回归**

运行相关 Vitest、typecheck、lint、diff check。

### Task 4: 最终验收

**Files:**
- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`
- Modify: this plan checkboxes.

- [x] **Step 1: 更新文档**

说明详情在当前工作页展开、导航动作需显式点击、priority 草稿只存内存、统一脱敏和空态入口。

- [x] **Step 2: 跑完整检查**

运行 `cd desktop && npm test && npm run lint -- --quiet && npm run typecheck && npm run build && npm run build:electron`，再运行 `node --test test/dao-desktop-smoke.test.js` 与 `git diff --check`。

- [x] **Step 3: 复核 scope**

确认只改本计划文件与路线图相关文件，不 stage 用户其他脏改动；记录最终 commit 和测试结果。

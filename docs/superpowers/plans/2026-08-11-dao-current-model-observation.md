# Dao Current Model Observation Implementation Plan

> **For agentic workers:** Execute inline in this thread because the shared worktree contains user changes. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Dao Flow App 在实时会话卡片上直接显示正在使用的模型，并在 Devin 进程内存观测断档时从固定本机状态目录安全恢复最近五分钟的模型事实。

**Architecture:** Electron main 新增一个只读、限量、可注入测试依赖的 Devin 状态源。现有 observation selector 选择网络 HUD 后再按哈希 ID 合并状态源，renderer 只消费安全 HUD 契约；当前工作和 HUD 负责直白展示，不参与路由决策。

**Tech Stack:** Electron main、Node.js `fs/promises`/`crypto`、React、TypeScript、Vitest

---

### Task 1: 安全的 Devin 状态事实源

**Files:**

- Create: `desktop/electron/services/devin-session-source.ts`
- Create: `desktop/electron/services/devin-session-source.test.ts`

- [x] **Step 1: 写失败测试**：用含 raw ID、系统 goal、Authorization、完整路径和路由事实的真实形状夹具，断言仅输出哈希 ID、最近五分钟生命周期与 `modelUid/provider/upstreamModel`；终止、过期、超大和非法文件被忽略。
- [x] **Step 2: 运行红灯**：`cd desktop && npm test -- --run electron/services/devin-session-source.test.ts`，预期因模块不存在失败。
- [x] **Step 3: 最小实现**：只扫描固定注入目录的 `.json` 文件，最多检查 512 个目录项和 64 个最新文件，单文件上限 256 KiB；安全文本限长，原始 ID 用 SHA-256 截断为 12 位。
- [x] **Step 4: 运行绿灯**：重复 focused test，预期 PASS。

### Task 2: 合并现有 HUD 观测

**Files:**

- Modify: `desktop/electron/services/dao-observation-source.ts`
- Modify: `desktop/electron/services/dao-observation-source.test.ts`
- Modify: `desktop/electron/main.ts`

- [x] **Step 1: 写失败测试**：网络 HUD 缺会话时文件会话进入 snapshot；同 ID 时新路由/活动事实覆盖，但 HUD cache/telemetry/verification 保留；读取失败保持原 snapshot。
- [x] **Step 2: 运行红灯**：`cd desktop && npm test -- --run electron/services/dao-observation-source.test.ts`。
- [x] **Step 3: 接入安全投影**：`createDaoObservationSource` 接收 `getDevinSessions`，仅在选定 HUD snapshot 后合并并重算生命周期/总数；`main.ts` 只传固定 `homedir()` 子目录。
- [x] **Step 4: 运行绿灯**：observation 与 dao-control focused tests PASS。

### Task 3: 直白展示当前模型

**Files:**

- Modify: `desktop/src/components/work/workItemModel.ts`
- Modify: `desktop/src/components/work/workItemModel.test.ts`
- Modify: `desktop/src/components/control/CurrentWorkControlView.tsx`
- Modify: `desktop/src/components/control/CurrentWorkControlView.test.tsx`
- Modify: `desktop/src/components/control/hud/HudSessions.tsx`
- Modify: `desktop/src/components/control/hud/HudSessions.test.tsx`
- Modify: `desktop/src/components/control/hud/hud.css`
- Modify: `desktop/src/theme/globals.css`

- [x] **Step 1: 写失败测试**：当前工作和 HUD 会话列表都出现“正在使用的模型 deepseek-v4-flash”，同时可见渠道 `dp` 与路由名 `swe-1-6-slow`；DOM 不含 raw ID/secret/path。
- [x] **Step 2: 实现结构化模型事实**：WorkItem 保存安全 `modelUid/provider/upstreamModel/provisional`，卡片优先把 upstream 标为正在使用模型，provisional 明示“渠道选择中”。
- [x] **Step 3: 更新 HUD**：列表卡片直接展示模型；详情节点改为“路由名/渠道/正在使用的模型”。
- [x] **Step 4: focused 验证**：相关 Vitest、typecheck、ESLint 与 diff-check PASS。

### Task 4: 集成、打包与本机验收

**Files:**

- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`

- [x] **Step 1: 完整验证**：`cd desktop && npm test && npm run typecheck && npm run lint -- --quiet && npm run build`。
- [x] **Step 2: 打包安装**：`npm run pack:mac`，备份并替换 `/Applications/Dao Flow.app`，不覆盖旧备份。
- [x] **Step 3: 黑盒验收**：确认安装后 endpoint 健康，snapshot 含最近 Devin 模型，App 当前工作/HUD 直接可见；确认超过五分钟文件会话不进入实时桌。
- [x] **Step 4: 文档与工作区检查**：记录只读状态源与隐私边界，`git diff --check`，不暂存用户其他改动。

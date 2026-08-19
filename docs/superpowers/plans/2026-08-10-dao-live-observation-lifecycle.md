# Dao Live Observation and Session Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Dao Flow 显示实际 IDE/Devin 流量的缓存与会话，并用可信时间完成自动退役和直白的长任务说明。

**Architecture:** Electron main 新增只读本地观测源选择器，仅为 HUD snapshot 在固定 loopback Dao 实例之间选择真实流量源；Devin ACP 连接器优先发现健康的 Desktop endpoint。生命周期继续由纯投影决定，UI 只消费安全结果并解释指标。

**Tech Stack:** Node.js CommonJS、Electron main、React/TypeScript、Vitest、Node assert tests

---

### Task 1: 固化当前失败证据

**Files:**

- Modify: `test/web-hud-projection.test.js`
- Modify: `desktop/src/components/control/hud/hudProjection.test.ts`
- Modify: `test/acp-stdio-proxy.test.js`

- [x] **Step 1: 写会失败的生命周期测试**

新增断言：active/requestInFlight 标记已过期 15 分钟的会话不在 `snapshot.sessions`；10–15 分钟区间仍投影为待确认。

- [x] **Step 2: 写会失败的 UI 语义测试**

断言原生 HUD 与 Web HUD 使用“长任务运行情况”，包含“不是聊天会话”的数据源解释和运行中/需要处理/已结束计数。

- [x] **Step 3: 写会失败的端点优先级测试**

用临时 descriptor 和本地假 HTTP server 证明显式 `DAO_ACP_API_URL` > 健康 Desktop > 既有注入地址 > 默认入口，且恶意/非 loopback descriptor 被拒绝。

- [x] **Step 4: 运行 focused tests 确认红灯**

Run: `node test/web-hud-projection.test.js && node test/web-hud-client.test.js`

Run: `cd desktop && npm test -- --run src/components/control/hud/hudProjection.test.ts`

Expected: 新增断言在实现前失败。

### Task 2: Devin 优先接入 Desktop 本地端点

**Files:**

- Create: `core/dao_local_endpoint.js`
- Create: `test/dao-local-endpoint.test.js`
- Modify: `dao-acp-stdio-proxy.js`
- Modify: `test/acp-stdio-proxy.test.js`
- Modify: `scripts/build-commercial-bundle.js`

- [x] **Step 1: 实现严格 descriptor 解析**

暴露 `parseLoopbackEndpointDescriptor(value)`，只返回 `http://127.0.0.1:<port>` 根地址；拒绝 credentials、query、hash、非根路径和越界端口。

- [x] **Step 2: 实现有界健康探测与候选选择**

暴露 `probeDaoEndpoint(base, options)` 与 `selectDaoEndpoint(options)`；只 GET `/origin/health`，限制响应字节，要求 `ok === true`、`dao_loaded === true` 且返回端口匹配。

- [x] **Step 3: 连接 ACP 启动路径**

保留显式 `DAO_ACP_API_URL` 最高优先级；否则读取固定 Desktop descriptor，健康时覆盖既有 loopback 注入；失败时保持既有行为。不得输出 descriptor 路径或会话 ID。

- [x] **Step 4: focused 验证**

Run: `node test/dao-local-endpoint.test.js && node test/acp-stdio-proxy.test.js && node --check dao-acp-stdio-proxy.js`

Expected: PASS。

### Task 3: Desktop 只读选择实际观测源

**Files:**

- Create: `desktop/electron/services/dao-observation-source.ts`
- Create: `desktop/electron/services/dao-observation-source.test.ts`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/electron/services/dao-control.ts`

- [x] **Step 1: 写源评分与安全测试**

构造 Desktop/legacy 两个 HUD v1 快照：外部源有 Devin 与缓存请求时必须选外部；Desktop 有更新的真实请求时选 Desktop；无合法候选时返回 Desktop fallback。断言只访问固定 descriptor 和 `/origin/health`、`/origin/hud/snapshot`。

- [x] **Step 2: 实现 main-only 选择器**

`createDaoObservationSource` 接收固定候选路径、当前 Desktop URL 和注入的读文件/fetch；验证 descriptor、健康响应、HUD v1 后按 active sessions、recent requests、generatedAt 排序。结果不包含 descriptor 路径，并只允许读取 HUD、usage、alerts、failure-stats、traces 五类精确运行事实。

- [x] **Step 3: 仅接入 HUD GET**

在 `requestDaoControl` 中仅当精确运行事实 GET 时调用选择器；配置、审计、备份、路由建议与所有写操作继续使用 `runtime().status().url`。失败时无缝回退 Desktop 请求。

- [x] **Step 4: focused 验证**

Run: `cd desktop && npm test -- --run electron/services/dao-observation-source.test.ts electron/services/dao-control.test.ts`

Expected: PASS。

### Task 4: 会话退役与直白任务组件

**Files:**

- Modify: `core/web_hud_projection.js`
- Modify: `test/web-hud-projection.test.js`
- Modify: `ui/web-hud.html`
- Modify: `ui/web-hud.js`
- Modify: `test/web-hud-client.test.js`
- Modify: `desktop/src/components/control/hud/HudSessions.tsx`
- Modify: `desktop/src/components/control/hud/HudTasks.tsx`
- Modify: `desktop/src/components/control/hud/HudPresentation.tsx`
- Modify: `desktop/src/components/control/hud/hud.css`
- Create: `desktop/src/components/control/hud/HudTasks.test.tsx`

- [x] **Step 1: 修复 15 分钟上限**

过滤规则改为：active 仅在新鲜时成立；所有非 active 会话都必须满足 `freshnessMs <= RECENT_SESSION_TTL_MS`，warning/stale 标记不得绕过上限。

- [x] **Step 2: 增加会话生命周期说明**

Web/原生 HUD 显示固定说明“10 分钟无活动待确认，15 分钟退出实时列表，历史不删除”。

- [x] **Step 3: 替换任务语义**

标题改为“长任务运行情况”，加入非会话说明与三个状态计数；条目标签将 fallback 改为“小计：备用渠道 N 次”等直白中文，不计算虚构可靠性分数。

- [x] **Step 4: focused 验证**

Run: `node test/web-hud-projection.test.js && node test/web-hud-client.test.js`

Run: `cd desktop && npm test -- --run src/components/control/hud/HudTasks.test.tsx src/components/control/hud/hudProjection.test.ts`

Expected: PASS。

### Task 5: 集成、打包与本机验收

**Files:**

- Modify: `desktop/README.md`
- Modify: `docs/DAO_DESKTOP_PARITY.md`

- [x] **Step 1: 运行完整验证**

Run: `npm test`

Run: `cd desktop && npm test && npm run typecheck && npm run lint && npm run build`

Expected: 所有命令 PASS；若 lint 只有仓库既有 warning，必须记录且无 error。

- [x] **Step 2: 构建并安装 macOS App**

使用仓库既有 Desktop 打包脚本生成 arm64 App，备份当前 `/Applications/Dao Flow.app` 后替换，并确认 Desktop endpoint 健康。

- [x] **Step 3: 更新 Devin 薄连接器**

将经过校验的连接器及其新本地端点模块安装到当前 Dao Flow Devin extension；只对新 ACP 进程生效，不强杀正在运行的会话。

- [x] **Step 4: 本机黑盒验收**

验证 App HUD 从实际运行源显示 Devin、非零缓存/请求样本；验证过期会话不占实时列表；验证“长任务运行情况”解释与计数；验证 provider/model priority 深度一致。

- [x] **Step 5: 文档与工作区检查**

记录单一实际数据面、过渡期只读观测、15 分钟退役与插件薄连接器边界。运行 `git diff --check`，只报告本切片文件，不暂存或覆盖用户其他脏改动。

验收说明：本机没有正在产生新流量的 Devin 会话，因此不伪造 Devin 在线状态；已用安装后的连接器模块一致性校验与真实 child-process descriptor 集成测试确认下一条 Devin ACP 会话会进入 Desktop。App 黑盒验收确认实际本机数据源、非零会话缓存、10/15 分钟退役和直白长任务文案。

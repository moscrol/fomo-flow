# Buzz-inspired ACP Activity Feed Implementation Plan

> **Scope:** 在现有 Dao Electron ACP 工作台中实现一条只读、安全的语义活动流；Buzz 仅提供信息架构参考。

## 1. 建立活动模型

**Files:**

- Modify: `desktop/src/components/collaboration/collaborationModel.ts`
- Modify: `desktop/src/components/collaboration/collaborationModel.test.ts`

- 扩展请求模型以保留 HUD 已公开的 `attemptCount`、`responseToolCount`、`errorCategory`、
  `firstSignalKind`、`cacheStatus` 等安全字段。
- 新增 `CollaborationActivityItem`、`ActivityFilter` 和
  `buildCollaborationActivity()`；生成生命周期、路由/工具、进度与结果事件。
- 对同键重复事件做合并，最多 80 项；文本统一裁剪并遮罩 Bearer、sk- 凭据及完整路径。
- 测试成功、失败、未知、工具调用、合并和安全边界。

## 2. 提取活动流组件

**Files:**

- Create: `desktop/src/components/collaboration/CollaborationActivityFeed.tsx`
- Create: `desktop/src/components/collaboration/CollaborationActivityFeed.test.tsx`
- Modify: `desktop/src/theme/globals.css`

- 用 `ControlBadge`/`ControlListEmpty` 复用 Dao 原生视觉原语。
- 提供四个筛选按钮、语义卡片、重复计数、相对时间和折叠 raw rail。
- 使用稳定的 aria 标签；不执行任何外部动作。

## 3. 接入 ACP 工作台

**Files:**

- Modify: `desktop/src/components/control/AcpWorkbenchControlView.tsx`
- Modify: `desktop/src/components/control/AcpWorkbenchControlView.test.tsx`

- 把 selected session 和安全请求投影传入 `CollaborationActivityFeed`。
- 保留现有 route/facts 展示，将旧的请求列表替换为新的语义活动流。
- 加载/错误/无会话路径保持现有行为。

## 4. 验证与交接

- 运行活动模型与组件聚焦测试，再运行桌面完整 Vitest、typecheck、lint、build。
- 运行 `git diff --check`，仅暂存上述文件与本设计/计划文档。
- 因 taskctl 与本地 taskboard 服务不可用，在最终交接中明确记录未同步状态和恢复后的同步动作。

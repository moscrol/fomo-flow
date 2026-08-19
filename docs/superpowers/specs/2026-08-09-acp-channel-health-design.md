# ACP 渠道健康矩阵设计

## 背景

Dao Electron 的 ACP Workbench 已经有会话目录、语义活动流、诊断事实卡、交接包和人工接手队列。当前渠道延迟与缓存事实只在选中会话的详情中出现，用户无法先从全局判断哪个 Dao provider 正在承载流量、是否出现失败或缓存退化。

## 目标

在现有 ACP Workbench 的筛选条与人工接手队列之间增加一个只读“渠道健康矩阵”，以安全 HUD projection 为唯一数据源，按 provider 汇总会话数、请求数、失败数、TTFT P95 和缓存 hit/miss P95。矩阵帮助用户先扫描协作面的渠道健康，再进入具体会话。

## 非目标

- 不新增后端 endpoint、Electron IPC 或持久化数据。
- 不显示 prompt、密钥、完整路径、原始 session/request ID。
- 不增加切换渠道、重试、取消或恢复等控制动作。
- 不重做已有会话诊断事实卡，只把它们聚合成全局摘要。

## 方案选择

1. **在 ACP 页面内联聚合**：改动最少，但聚合规则会和 JSX 混在一起，难以单测和复用。
2. **独立 renderer-owned 聚合模型 + 纯展示组件（采用）**：`collaborationChannelHealth.ts` 负责纯函数和安全收敛，`CollaborationChannelHealthView.tsx` 负责呈现；既不改变数据边界，又能对排序、去重和空态做确定性测试。使用 `View` 后缀避免 macOS 大小写不敏感文件系统把组件与纯模型解析为同一模块。
3. **新增后端渠道统计接口**：可得到更长期的统计，但扩大 API/IPC 面，超出当前“搬展示层”的范围。

## 详细设计

### 聚合模型

导出 `buildCollaborationChannelHealth(providers, sessions, recentRequests)`，返回最多 12 个 `CollaborationChannelHealthItem`，每项包含：

- `provider`：经过安全文本收敛的渠道名；
- `sessionCount`、`requestCount`、`failureCount`：由 session route 和 recent request 投影聚合；
- `overallP95TtftMs`、`cacheHitP95TtftMs`、`cacheMissP95TtftMs`：来自 provider latency，缺失时为 null；
- `tone`、`status`：失败数大于 0 为告警；没有任何流量为 muted；其余为 good；
- `detail`：安全的“活跃会话 / 请求 / 失败”摘要。

渠道集合取 providers、session route provider、recent request provider 的并集，按失败数降序、请求数降序、provider 名称升序排列，保证同一快照稳定。provider 名称只允许短文本，遮蔽 Bearer/sk-*、路径和控制字符。

### React 组件

`CollaborationChannelHealthView` 接收已标准化的 providers、sessions、recentRequests，内部用 `useMemo` 调用聚合模型。渲染 `section[aria-label="渠道健康矩阵"]`、`role=list` 和每个渠道的摘要卡；无渠道时显示“暂无渠道观测”。组件不包含按钮和副作用。

### 页面接入

`AcpWorkbenchControlView` 在现有来源筛选条之后渲染矩阵，再渲染人工接手队列。所有数据直接来自 `snapshot`，不改变 refresh、filter 或 selected session 状态。

### 测试与安全

- 模型测试覆盖 provider 并集、失败优先排序、延迟缺失、重复 provider 和敏感文本收敛。
- 组件测试覆盖健康/告警/空态展示，并断言不会渲染内部 ID。
- ACP Workbench 测试断言矩阵出现且能展示 provider P95。
- 完成 desktop vitest、typecheck、lint、build、Electron bundle 和 root smoke。

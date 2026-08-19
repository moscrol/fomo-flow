# ACP 会话接手队列设计

## 背景

Buzz 的 inbox 价值不在于复制聊天，而在于把需要人或下一位代理关注的协作单元排到前面。Dao 已经有安全 ACP 会话目录、语义活动流、诊断事实卡和交接包，但操作者仍要逐个打开会话才能知道先看谁。本切片在现有 ACP Workbench 中增加一个只读“接手队列”，将已有 session projection 转换成结果优先的关注列表。

## 目标与非目标

### 目标

- 从现有 `CollaborationSession[]` 生成稳定、可测试的关注项排序。
- 优先显示验证阻塞、失败/最近工具错误、stale/失联；其次显示正在进行且有请求在途的会话。
- 每项只展示安全目标、阶段、相对时间和人工建议；点击只定位会话详情。
- 队列为空时给出明确的“无需接手”状态，最多渲染 12 项以保持界面可读。

### 非目标

- 不新增 endpoint、IPC、轮询或持久化状态。
- 不实现取消、重试、恢复、分配、聊天、通知或后台自动动作。
- 不显示 session/request 原始 ID、prompt、密钥、完整路径、工具参数或 raw 事件。
- 不改变现有会话目录、活动流、诊断事实卡和交接包的语义。

## 方案

### 纯模型

新增 `collaborationAttention.ts`，导出 `buildCollaborationAttention(sessions, now)`。每个会话最多产生一个关注项，按以下优先级从高到低选择：

1. `verification.blocking`：`blocked`，建议先检查验证阻塞。
2. `warning`、`failures.hasLastError`、`lastToolOk === false` 或失败计数大于零：`failed`，建议先审阅失败信号。
3. `stale` 或非活跃且生命周期提示失联：`stale`，建议确认心跳和最近活动。
4. `active && requestInFlight`：`watch`，建议继续观察在途请求。

同级按最近活动时间倒序，最多 12 条。模型携带内部 `sessionId` 供点击回定位，但组件不渲染该字段。

### React 组件

新增无状态 `CollaborationAttentionQueue`，内部调用纯模型，展示标题、数量、优先级标记、目标、阶段/时间和建议。组件通过 `onSelectSession(sessionId)` 向页面交回选择动作。ACP Workbench 点击队列项时切换到 `all` surface filter 并选中对应会话，不发起任何 API 写请求。

### 安全与降级

- 输入已经由 `normalizeCollaborationSnapshot` 裁剪；组件不接触原始 payload。
- 无关注项显示空状态；异常会话字段使用模型默认值，不把未知状态升级为失败。
- tone 只表达投影事实，不代表系统自动判断或执行结果。

## 验证

- 模型测试覆盖优先级、同级排序、上限和空状态。
- 组件/ACP 集成测试覆盖点击后会话选中与 filter 恢复为 `all`。
- 运行 desktop Vitest、typecheck、lint、build、Electron bundle 和根 smoke test。

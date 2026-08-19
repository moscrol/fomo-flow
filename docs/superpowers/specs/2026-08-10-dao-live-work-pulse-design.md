# Dao 当前工作脉冲设计

日期：2026-08-10
状态：按用户“最优路径推进”的授权实施

## 目标

借鉴 Claude HUD 的“始终知道现在在做什么”体验，为 Dao Flow 的当前工作桌补齐可扫读的实时脉冲。它必须适用于 Devin、Codex 与 ACP，而不是依赖某一种 IDE 的 transcript 或 statusline API。

## 范围

当前工作卡片与选中详情使用现有的安全 HUD/tasks 投影显示：

1. 当前 Todo 或已知阶段。
2. Todo 完成度或任务登记进度。
3. 最近活动的新鲜度。
4. 已投影的验证状态和最近工具/任务结果。

信息优先级固定为：明确目标、当前 Todo、会话类型。Todo 的内部前缀不显示；没有结构化 Todo 时只陈述已知阶段，不推测用户意图。

## 边界

- 不读取 Claude Code transcript、Devin 原始消息、工具参数或提示词。
- 不增加 HUD/Taskboard endpoint、IPC、远程能力或后台轮询。
- 不展示原始 session/job ID、Authorization、凭据或完整本地路径。
- 不自动创建/更新 Taskboard 事项，不改变 provider/model 或路由 priority。
- 不伪造 parent/child Agent 关系；缺少可信关系时不显示 Agent 树。

## 设计

`workItemModel` 继续是 renderer 的安全聚合边界。它为 session/task Work Item 计算可选的 `pulse`：

- session：当前 Todo、完成度、验证状态、最近工具结果与新鲜度。
- task：登记进度、最近尝试/结果与新鲜度。

`CurrentWorkControlView` 的卡片展示一行当前工作和一行进度；点击后，详情面板以事实字段呈现工作脉冲。所有文本经过现有第二层展示清洗和长度限制。

Taskboard 继续作为长期工作账本：当前工作表达实时事实，Taskboard 保存已确认的目标、责任和验收条件。两者只能通过用户显式“加入任务板”连接。

## 验收

- 空 goal 的 Devin 会话优先显示安全 Todo，且不显示 Todo 内部前缀。
- 有明确 goal 的会话仍展示目标，并可见当前 Todo/进度。
- 没有 Todo 时显示可信阶段或会话类型，而不是“未识别目标”。
- 失败、验证阻塞、任务状态和新鲜度可见且可解释。
- 没有新增写请求、自动路由或敏感数据渲染。

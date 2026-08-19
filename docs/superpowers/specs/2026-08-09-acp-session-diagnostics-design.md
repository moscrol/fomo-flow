# ACP Workbench 会话诊断事实卡设计

## 背景

Dao Web HUD 的选中会话详情已经展示验证、失败信号、推理 Token、上下文压缩、渠道尾延迟与缓存尾延迟。原生 ACP Workbench 目前只展示路由、基础耗时、缓存摘要、待办和语义活动，因此同一份安全投影在两个入口的诊断密度不一致。本切片只补齐展示层，不改变运行时协议或任务控制能力。

## 目标与非目标

### 目标

- 在 ACP Workbench 的会话详情中逐项展示 Web HUD 已有的诊断事实。
- 复用 `/origin/hud/snapshot` 的现有安全投影，并把渠道延迟数据以最小类型投影传入会话详情。
- 把事实卡生成逻辑抽成纯函数，保证缺失数据时稳定显示 `—`/明确的未知状态。
- 让事实卡在窄窗口下仍能单列阅读，并通过 tone 标识阻塞和风险。

### 非目标

- 不新增后端 endpoint、轮询周期、IPC 或写操作。
- 不渲染 prompt、密钥、完整路径、原始请求参数或原始会话 ID。
- 不添加取消、重试、恢复等控制按钮，也不伪造任务状态变化。
- 不重构已经完成的 HUD、语义活动流或交接包切片。

## 方案

### 数据边界

在 `collaborationModel.ts` 中增加最小的 `CollaborationProvider`/latency 类型，并从快照的 `providers` 数组投影：渠道名称、整体 P50/P95、缓存命中 P95、缓存未命中 P95。所有文本沿用现有长度裁剪和工作区 basename 规则；未找到渠道时使用空 provider，事实卡显示 `—`。

### 展示边界

新增 `acpSessionDiagnostics.ts` 纯构建器，输入标准化会话、可选渠道和当前时间，输出有序事实数组：

1. 验证与阻塞
2. 失败信号与最近工具结果
3. 会话缓存与新鲜度
4. 推理 Token、首字延迟、轮次耗时
5. 渠道 TTFT P50/P95、缓存命中/未命中 P95
6. 上下文压缩、模型路径、状态来源

新增 `AcpSessionDiagnostics.tsx` 只负责渲染这些事实卡，不读取 API、不持有业务状态。`SessionDetail` 通过 provider ID 选择渠道并挂载组件，现有路由、待办、活动流和交接动作顺序保持不变。

### 状态与安全

- `blocking` 或明确失败信号使用告警 tone；没有样本时使用 muted tone，不推断成功。
- 延迟和 Token 使用已有格式化器，不显示原始数值之外的上下文内容。
- 事实卡不显示 session/request/provider 内部 ID；provider 仅显示已有安全名称。

## 验证

- 纯构建器测试覆盖完整数据、缺失 provider、阻塞和失败 tone。
- ACP Workbench 集成测试覆盖 provider 延迟字段和事实卡文本，并确认空快照仍能进入空态。
- 运行桌面 Vitest、typecheck、lint、Vite build、Electron bundle 和根 smoke test。

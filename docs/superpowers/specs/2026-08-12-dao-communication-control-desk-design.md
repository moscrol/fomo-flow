# Dao Flow 通信控制桌设计

## 状态

已批准执行。本文把 cc-haha 的可复用设计理念转译为 Dao Flow 的中间层边界，不引入 cc-haha 的 Claude runtime 或执行工作台。

## 目标

Dao Flow 位于 Codex、Devin、ACP、IDE 等入口与模型 API 服务层之间。它需要把通信入口、路由决策、运行事实、人工审批和交接证据组织成一张可解释的控制桌：用户能回答“谁从哪里来、现在走哪里、发生了什么、是否需要我决定、何时退出实时视图”。

## 设计原则

1. **入口通道与上游路由分层**：Codex、Devin、ACP、IDE 是来源通道；provider、model、协议和 priority 是上游路由事实。UI 和数据模型不再用一个“渠道”概念混淆两者。
2. **通道是能力边界，不是任意透传**：每个入口只声明它能观测、发送、请求审批或交接什么；能力缺失时显示明确的“未接入/不支持”，不猜测、不降级为隐式写操作。
3. **会话是工作对象**：会话、请求、任务、路由尝试、缓存样本、审批、产物和交接通过安全的内存关联组织；没有可信 owner key 时保持并列，不按时间、工作区、provider 或 model 猜测归属。
4. **证据先于自动化**：Dao 只投影安全事实和建议。路由 priority、provider/model、任务停止和远程能力均不自动改变。
5. **实时与历史分离**：实时桌使用新鲜事实和租约窗口；退役只影响展示，不杀进程、不删除历史。历史仍可在任务、请求和证据页查询。
6. **边界最小化**：Electron main 持有本地 runtime 与敏感能力，renderer 只消费白名单安全投影；不把 prompt、Authorization、完整路径或原始 session/job/request ID 带入 UI、持久化或交接。

## 架构

```text
入口适配器
  Codex / Devin / ACP / IDE
        |
        v
安全通道信封（来源、协议、能力、freshness、opaque owner key）
        |
        v
工作对象投影（会话 / 请求 / 任务 / 证据 / 审批 / 产物）
        |
        +--> 路由观察：provider / model / protocol / priority / reason
        +--> 决策边界：只读预演、人工确认、可回退交接
        +--> 实时生命周期：live / attention / detached / retired / history
        |
        v
上游 API 服务层（Dao 现有 runtime）
```

本切片不新增远程服务、隧道、MCP/A2A 能力或新的 runtime endpoint。优先复用 `/origin/hud/snapshot`、`/origin/tasks` 及已有路由证据投影。

## 数据模型

### ChannelCapability

```text
source: acp | codex | devin | ide | other
protocol: acp | openai-chat | openai-responses | anthropic | unknown
observability: available | unavailable | unknown
send: available | unavailable | unknown
approval: available | unavailable | unknown
handoff: available | unavailable | unknown
reason: safe human-readable explanation
lastSeenAt: number
```

能力字段只描述 Dao 当前观测到的能力，不代表给入口新增权限。`send` 和 `approval` 必须对应现有的显式用户操作；默认状态不是自动允许。

### WorkObjectProjection

```text
key: opaque in-memory key
kind: session | request | task | evidence | approval | artifact
source: source channel
title: sanitized human-readable title
phase: safe phase label
status: live | attention | detached | retired | history
route: provider/model/protocol/priority facts
lastActivityAt: number
ownerKey: opaque in-memory owner, optional
nextAction: read-only recommendation
```

原始 ID 只作为当前窗口内的导航令牌，不渲染、不持久化、不进入日志和交接包。没有 `ownerKey` 的对象不建立关系线。

## UI 方案

在现有四张一级桌内逐步落地：

- **当前工作**：按 `live / attention / planned / history` 投影工作对象，显示来源、目标、当前阶段、上游模型和下一步。
- **ACP 协作**：新增“入口能力”摘要，显示每个 Codex/Devin/ACP 入口能观测什么、能否发送、是否需要审批；协作链只展示可信 owner 关系。
- **流量观测**：把“来源通道”和“上游路由”分成两列，时间线展示真实路由、缓存、亲和、fallback 和失败原因。
- **任务与产物**：展示任务尝试、产物和交接事实；`codex-turn` 只显示运行事实，不伪造正文。
- **决策中心**：只提供预演、证据查看和用户确认入口，不执行自动切换。

## 生命周期与错误处理

- 没有新鲜活动或心跳的对象在实时视图中退役；历史对象保留在历史页。
- 来源不可达时标记 `unknown/unavailable`，保留上一次安全投影并显示数据新鲜度，不显示伪造的正常状态。
- 能力声明缺失时显示“不支持/未观测”，不把未知当成允许。
- 关联失败时保留独立对象并说明“未关联”，不通过相似 provider/model 或时间窗口猜测。

## 最小实现切片

第一阶段实现一个新投影模块，并扩展两个既有纯模型：

1. `channelCapabilityModel`：从已有 snapshot/session/host facts 生成来源能力矩阵，并统一来源通道与上游路由命名。
2. `workItemModel`：继续负责 session/task 的实时工作对象，不新增平行模型；补充来源通道与上游路由的明确展示语义。
3. `deskEventModel`：继续负责 session/task/request/evidence 的安全活动流和可靠 owner 关联；复用现有五分钟实时退役逻辑。

不在本阶段新增发送、审批执行、自动路由、远程连接或持久化 schema。

## 验收标准

1. Codex、Devin、ACP、IDE 来源与 provider/model 路由在数据模型和 UI 文案中可明确区分。
2. 能力矩阵对缺失字段稳定返回 `unknown`，不会把未知当成可发送或可审批。
3. 有可信 owner key 的对象可形成工作链；没有 owner key 的对象保持独立并说明原因。
4. 超过实时窗口的对象不会出现在当前工作或实时协作链，但仍能在历史任务/证据中查看。
5. 序列化投影不包含 prompt、Authorization、完整路径或原始内部 ID。
6. 不新增远程 endpoint，不修改 provider/model 或 priority，不触发任何写操作。
7. Desktop 全量测试、typecheck、lint、build、macOS 打包和实机 ACP/流量观测验收通过。

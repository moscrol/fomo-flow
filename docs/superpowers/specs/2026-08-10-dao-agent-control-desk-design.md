# Dao Flow Agent 控制桌设计

- 日期：2026-08-10
- 状态：用户已要求建立 TODO 并执行
- 第一交付：统一 Work Item 与「当前工作」桌

## 产品定位

Dao Flow 是本地优先的 Agent 交通与工作控制台，位于模型 API 服务层和本地 IDE、Codex、Devin、ACP Agent 之间。网关、反代与协议兼容是底座；用户面对的核心价值是把一次工作看成可解释、可干预、可交接的对象。

它不复制 IDE、通用聊天、远程 relay 或自动代理运行时。它以 Dao 自己的本地路由、脱敏 HUD 投影和显式控制 API 为唯一事实来源。

## 路线图

1. **P0 当前工作桌（本切片）**：把会话、任务、最近请求和路由事实收敛成 Work Item；先解决“现在有什么在做、哪里需要我处理”。
2. **P1 显式干预与交接**：在底层已有安全授权时加入明确、可回退的任务操作；保留人工保存才改变 priority 的约束。
3. **P1 产物审阅与终端事实**：把已有安全产物、差异/命令摘要挂到 Work Item，不嵌完整 IDE 或任意 shell。
4. **P1 导航收口**：低频的隧道、协议兼容、本地接口和外部接入进入高级连接；主导航聚焦工作、交通和交接。

## P0：当前工作桌

### 目标

新增一个原生 `当前工作` 视图，作为默认进入 Dao Flow 后的第一张桌面。它按用户能行动的状态展示来自 Codex、Devin、ACP 与 IDE 的安全工作记录：

- **正在进行**：活跃会话、运行/排队任务。
- **需要我处理**：会话验证阻塞、告警/失败、失联或失败任务。
- **最近完成**：成功或可审阅的终态任务。

每个条目展示来源、目标/任务摘要、当前阶段、路由事实、最近活动时间和一条下一步建议。点击只会带用户进入既有的协作会话或任务详情，不执行写操作。

### 数据边界

视图只读取已有的本地、受控端点：

- `GET /origin/hud/snapshot`：会话、渠道、最近请求和运行状态。
- `GET /origin/tasks`：任务及尝试/产物的安全摘要；当旧 runtime 不支持时，仅以 HUD 中的任务摘要降级。

新增纯 renderer-owned 模块 `workItemModel.ts`。它调用既有 `normalizeCollaborationSnapshot`、`normalizeTasks` 的输出，不自行读取网络或存储。每条 Work Item 只保留：

```text
key, kind(session|task), source, title, phase, status,
route(provider/model), lastActivityAt, tone, bucket,
suggestion, target(view + private source id)
```

原始 session ID / job ID 仅作为内存中的导航令牌，不渲染、不写本地持久化、不进入 handoff 或日志。没有稳定关联键时，会话和任务不得猜测合并；同一工作区相近活动只做视觉并列。

### UI 与导航

- 在 `运行中` 分组最前新增 `当前工作`，随后是首页、实时情况、问题与数据。
- App 默认初始视图改为 `work`；空态解释“先从 Codex、Devin 或 ACP 发起一轮任务”，并提供前往实时情况/接入渠道的按钮。
- 新增 `CurrentWorkControlView`，每 3 秒并行刷新 HUD 与任务数据，错误时保留上一次安全数据并显示可恢复提示。
- Work Item 卡片点击通过 App 内存导航带上选择令牌：会话跳转协作会话并选中该会话；任务跳转任务进度并选中该任务。目标详情页不显示令牌。
- 首页保留为配置与运行概览，不承担实时工作台职责。

### 明确不做

- 不新增 runtime endpoint、远程服务、数据库或身份系统。
- 不自动暂停、重试、取消、派发任务，不自动变更渠道优先级。
- 不接入 cc-haha 的 Claude runtime/终端执行器、Buzz relay/聊天、OmniRoute 自动路由。
- 不把隧道或协议桥删除；导航收口留到 P1。

### 验收

1. Work Item 纯模型对活动、注意、完成、空态、脱敏和未知字段均有确定性测试。
2. 当前工作视图只请求上述现有 GET 端点，任务端点失败时展示 HUD 降级说明。
3. 点击会话/任务能进入现有详情并选中对应记录；不触发任何 POST/PUT/DELETE。
4. 桌面 typecheck、lint、全量 Vitest、production build 与 Electron bundle 通过；根目录 desktop smoke 通过。

## 后续仓库吸收边界

- **OmniRoute**：保留可解释评分、预算、弹性和兼容性；profile 继续只是人工观察镜头。
- **cc-haha**：后续只吸收 Work Item 上的多会话工作集、审批、产物/差异审阅与技能绑定；不导入其 Claude runtime。
- **Buzz**：后续只吸收项目/工作项事件、交接、审批与可搜索证据；不导入 Nostr relay、IM 或远程社区。

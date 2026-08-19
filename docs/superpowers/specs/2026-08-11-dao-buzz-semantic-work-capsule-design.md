# Dao Flow Buzz 语义层、Agent 活动流与工作舱设计

- 日期：2026-08-11
- Taskboard：DAOFLOW-7
- 状态：已实施并验收（DAOFLOW-7 `in_review`）

## 背景

Dao Flow 已经具备当前工作、HUD 安全观测、ACP 会话活动、任务生命周期、路由证据、
决策收件箱、Taskboard 和交接摘要，但这些事实仍分散在不同组件。用户能够找到单项功能，
却不能从一个工作上下文中快速回答：谁正在做什么、请求实际走了哪里、结果如何、是否需要介入。

Buzz 值得吸收的不是 Nostr Relay、聊天室或 Git 托管，而是三项产品语义：

1. 活动以“动作、对象、结果”呈现，原始细节按需展开；
2. 人、Agent、工作流、审批和产物共享同一条可追溯事件脉络；
3. 一个分支或任务成为承载讨论、执行、验证和交接的工作上下文。

本设计将这三项语义二创为 Dao Flow 的本地安全事件层与工作舱。

参考：

- <https://github.com/block/buzz/blob/main/VISION_ACTIVITY.md>
- <https://github.com/block/buzz/blob/main/VISION_PROJECTS.md>
- <https://github.com/block/buzz/blob/main/VISION_AGENT.md>

## 产品定位

Dao Flow 是位于本地 IDE、Devin、Codex、ACP Agent 与模型 API 服务之间的通信和协作控制桌。
它观察、解释、聚合并提供人工控制，不取代 IDE、Agent、任务系统或代码托管平台。

本阶段完成后，工作台应直接回答：

- 现在有哪些 Agent 或长任务正在工作；
- 刚刚发生了哪些请求、路由、工具、任务和产物事件；
- 某个工作当前做到哪里、最近结果是什么；
- 哪些事项真的需要用户处理；
- 相关事实来自哪里，是否只是建议。

## 已选方案

### 方案 A：在现有组件之上增加 renderer-owned 语义层（采用）

新增纯 TypeScript `DeskEvent` 投影和 `WorkCapsule` 聚合。它只接收已经归一化的安全数据，
不新增后端存储或协议。当前工作加载现有 HUD、tasks、Taskboard 和 decision inbox，将事实投影成
统一活动流；所选 Work Item 的可靠关联事件进入工作舱。

优点是增量、安全、可测试，能复用现有数据源和组件；缺点是第一阶段不会得到跨设备历史或
团队聊天室。

### 方案 B：引入本地持久化事件总线（暂缓）

由 Electron main 写入追加式事件库，再由各页面订阅。它能提供长历史、搜索和审计，但会立刻
引入迁移、保留期限、清理和隐私治理问题。待 renderer 事件契约稳定后再评估。

### 方案 C：嵌入 Buzz Relay 或复刻房间系统（拒绝）

该方案会引入 Nostr、身份密钥、WebSocket Relay、数据库和团队通信边界，使 Dao Flow 从本地
中间桌偏移为另一套协作平台，并扩大远程攻击面。

## 范围

### 本阶段实现

1. renderer-owned `DeskEvent` 安全事件契约和纯投影。
2. 当前工作顶部的“刚刚发生”Agent 活动流。
3. 所选 Work Item 的“工作舱”，聚合可靠关联的进度、路由、任务尝试、产物、人工处理和交接入口。
4. 决策收件箱中的安全事项进入全局活动流，并明确标注“需要你确认”。
5. Taskboard 事项进入全局计划活动，不猜测它与运行会话的关系。
6. 现有五分钟无活动即退出实时工作桌的规则保持不变。

### 非目标

- 不引入 Nostr、公共 Relay、聊天室、私信、语音、Canvas 或 Git 托管。
- 不新增公网服务、远程 Agent 注册、自动分派或任意 Webhook/Shell 工作流。
- 不保存完整活动历史；第一阶段每次轮询从现有安全快照重新投影。
- 不自动切换 provider/model，不自动保存或改变 priority。
- 不把时间接近、渠道相同、模型相同或工作区相同视为可靠关联。
- 不读取原始 prompt、Authorization、完整路径、命令正文或原始 session/job ID。

## 数据契约

### DeskEvent

`DeskEvent` 是 renderer-owned 的只读显示模型：

```ts
type DeskEventKind =
  | 'lifecycle'
  | 'progress'
  | 'request'
  | 'route'
  | 'tool'
  | 'task'
  | 'artifact'
  | 'approval'
  | 'handoff'
  | 'unknown'

type DeskEventState =
  | 'running'
  | 'waiting'
  | 'success'
  | 'warning'
  | 'failure'
  | 'retired'
  | 'unknown'

type DeskEvent = {
  key: string
  at: number
  kind: DeskEventKind
  state: DeskEventState
  actor: string
  verb: string
  object: string
  outcome: string
  detail: string
  importance: 'high' | 'normal' | 'quiet'
  source: 'session' | 'request' | 'task' | 'taskboard' | 'decision'
  ownerKey?: string
  evidence: Record<string, boolean | number | string | null>
}
```

约束：

- `key` 和 `ownerKey` 使用纯投影生成的不透明显示键，不能包含原始 session/job/request ID。
- `actor/verb/object/outcome/detail/evidence` 全部经过统一 `sanitizeDisplayText` 和长度限制。
- `evidence` 只允许布尔、有限数字、脱敏短文本和 `null`。
- 事件最多 80 条；相同稳定键更新原行，不制造重复状态噪音。
- 失败、阻塞和需要批准的事件优先；普通读取和心跳降为 quiet 或抑制。
- 无法识别的事实显示“事实类型尚未识别”，不能猜测成功、目标或关联。

### WorkCapsule

```ts
type WorkCapsule = {
  item: WorkItem
  events: DeskEvent[]
  current: string
  progress: string
  outcome: string
  route: WorkItem['routeFacts']
  task?: CollaborationTask
  hasHandoff: boolean
}
```

`WorkCapsule` 不产生新的业务状态，只聚合现有 `WorkItem`、安全事件、任务投影和交接可用性。

## 事件来源与关联规则

### 会话

从安全 `CollaborationSession` 生成生命周期、当前进度、路由、验证和缓存事实。会话事件只属于
该会话 Work Item。

### 请求

从 `CollaborationSnapshot.recentRequests` 生成全局请求、路由、缓存和结果事件。当前安全请求投影
没有稳定 session 关联键，因此第一阶段不得把请求附着到具体会话工作舱。后续只有上游提供明确、
main-only 关联并投影为不透明 owner key 后才能关联。

这同时替代现有 ACP 活动流仅按 `request.source === session.surface` 归并请求的做法；该启发式不能
进入新的 DeskEvent/WorkCapsule 契约。

### 任务与产物

从 `CollaborationTask` 生成排队、运行、尝试、失败、完成和产物事件。任务事件只属于对应任务
Work Item；产物引用继续使用 basename/安全摘要，不读取文件内容。

### Taskboard

Taskboard 的 `identifier/title/status/priority/updatedAt` 生成计划事件。没有显式关联时，它只进入
全局活动流和现有“计划与验收”区域，不附着到 session/task 工作舱。

### 决策与审批

从现有 `projectDecisionInbox()` 的安全结果生成 approval 事件。事件显示建议、严重度和是否需要
用户确认；确认、稍后提醒仍由现有决策中心处理，当前工作只提供跳转，不复制写入逻辑。

### 交接

交接正文只由现有安全 handoff endpoint 在选择 Work Item 后读取，DeskEvent 只记录“交接摘要已
准备”这一事实，不复制正文到事件 evidence，也不自动发送。

## 用户界面

### 当前工作信息顺序

1. 观测源和数量摘要；
2. “刚刚发生”语义活动流；
3. “需要我处理”；
4. “计划与验收”；
5. “正在进行”；
6. 选中项“工作舱”。

### 刚刚发生

- 标题旁显示最新事件时间和总数；
- 默认显示“全部”，可切换“需要处理”“路由与请求”“进展与产物”；
- 每行优先展示 `actor + verb + object → outcome`；
- 失败/审批高显著，成功正常，心跳和普通读取弱化；
- 原始安全 evidence 用 `<details>` 按需展开；
- 空态明确区分“观测正常但没有活动”和“观测源不可用”。

### 工作舱

工作卡点击仍只在当前工作页选中，不立即导航。工作舱按顺序展示：

1. 现在在做、进度、最近结果和最近活动；
2. 可靠关联的活动时间线；
3. 当前模型、渠道与路由状态；
4. 任务产物与终端事实（仅任务）；
5. 路由建议与内存草稿；
6. 显式打开详情、加入 Taskboard、知晓、复制/保存交接。

所有已有动作边界保持不变。

## 数据流

```text
HUD safe snapshot ─┐
tasks projection ──┼─> normalize existing models ─> projectDeskEvents ─> Activity Feed
Taskboard snapshot ┤                                  │
decision inbox ────┘                                  └─> buildWorkCapsule ─> Work Capsule
```

网络和 IPC 请求仍由 `CurrentWorkControlView` 负责；展示组件只接收安全模型和回调，不读取 raw
payload，不自行请求 endpoint。

## 刷新、错误与生命周期

- HUD、tasks 和 decision inbox 采用同一轮并行 GET；Taskboard 保留 Electron host 的独立 15 秒轮询。
- 使用递增 sequence 防止旧请求覆盖新选择；卸载后禁止状态回写。
- HUD 失败时保留上一次安全工作桌与活动流，并显示自动重试；tasks/decision 单项失败时保留其他
  来源，显示来源级降级说明。
- Session 和 task 超过五分钟无可信活动后退出当前工作；最近请求事件可在 HUD 已有有界保留窗口内
  继续显示，但不得使已退役会话重新进入工作桌。
- 选中项退出实时桌时关闭工作舱；历史事实仍可由现有历史/观测入口查看。

## 隐私与授权边界

- renderer 不接收或持久化 prompt、Authorization、API key、完整路径或命令正文。
- 原始 session/job/request ID 仅可在现有内存导航 token 内存在，不能进入 DeskEvent、DOM、
  localStorage、handoff、控制台或测试快照。
- 活动层只读；唯一写动作继续由现有 Taskboard、decision inbox、handoff 和路由设置组件承担。
- 路由建议明确标为 advisory；工作舱不能自动重排或保存 priority。
- 不新增 endpoint、IPC、外部服务或网络来源。

## 测试缝

用户可见行为只在以下公开边界测试：

1. `projectDeskEvents(input)`：给定规范化安全输入，输出有界、排序、脱敏且不猜关联的事件。
2. `buildWorkCapsule(item, events, task, hasHandoff)`：只包含可靠 owner 事件和既有安全事实。
3. `DeskActivityFeed`：筛选、显著性、空态、evidence 展开和无敏感 DOM。
4. `WorkCapsulePanel`：会话/任务差异、活动、产物、路由建议与显式动作。
5. `CurrentWorkControlView`：并行 GET、部分降级、竞态保护、五分钟退役和导航边界。
6. `App`：默认当前工作可达，选择工作不导航，显式动作才进入 ACP/任务页。

测试不得通过读取内部 state、私有函数或数据库验证；预期值使用规格中的固定例子，不重新实现投影
算法。安全测试必须包含 Authorization、Bearer、sk、Unix/Windows/file 路径和原始 ID 样例。

## 验收标准

1. 当前工作能以“谁做了什么、结果如何”显示会话、请求、任务、Taskboard 和审批事实。
2. 失败、阻塞、等待批准和超时比正常读取更醒目；静默和无数据有诚实状态。
3. 选中 session/task 后能在当前页看到工作舱及可靠关联活动。
4. 不按 surface、provider、model、时间或 workspace 猜测跨来源关联。
5. 五分钟无活动的会话和任务仍退出实时工作桌。
6. 没有自动 provider/model/priority 变更，也没有新增远程或执行能力。
7. DOM、事件、handoff 和持久化中不出现 prompt、Authorization、完整路径或原始 ID。
8. 聚焦测试、Desktop 全量 Vitest、typecheck、lint、renderer build、Electron build 和根目录 smoke
   全部通过。
9. Taskboard DAOFLOW-7 写入实现与验证评论并移至 `in_review`，不擅自标记 `done`。

# Dao Agent 协作控制桌信息架构设计

## 目标

把 Dao Flow 从“路由配置页面集合”收敛为位于本地 IDE/Agent 与 API 服务之间的
Agent 流量与协作控制桌。日常界面首先回答四个问题：

1. 现在谁在工作；
2. 请求实际走了哪里、效果如何；
3. Agent 之间如何分工、产生了什么；
4. 哪些事项需要用户介入。

Provider、model、protocol、priority 等配置能力继续保留，但不再占据日常一级导航。

## 产品定位

Dao Flow 是本机 Agent Traffic & Collaboration Desk：

- 对下连接 Devin、Codex、ACP 客户端与本地 IDE；
- 对上连接模型渠道和兼容 API；
- 中间负责路由、观测、会话归因、任务生命周期、产物与人工交接；
- 既可以作为本地 gateway，也可以作为 ACP Host 和只读协作控制面；
- 不把协议桥、隧道或单个 IDE 插件作为产品主叙事。

## 信息架构

侧边栏只保留四个一级入口。

### 1. 当前工作

沿用 `CurrentWorkControlView` 作为默认入口，聚合：

- 五分钟内真实活跃的 Agent 会话；
- 运行中或需要处理的长任务；
- 用户明确连接的本地 Taskboard 计划事项；
- 选中事项的安全详情、路由建议、产物与显式操作。

它不展示完整历史，不自动停止进程，不自动改变 provider/model/priority。

### 2. 流量观测

将现有“首页、实时情况、路由观察、问题与数据”收敛为一个一级入口，内部使用直白的
分段导航：

- `现在是否正常`：运行时、请求、告警和下一步；
- `最近请求`：实际模型、渠道、协议、延迟、缓存命中和 fallback；
- `为什么这样走`：规定 priority、实际尝试链、亲和与只读建议；
- `问题记录`：失败、trace、审计和备份入口。

“模型怎么走”不再作为一级配置页；用户从真实请求进入某条路由的证据，再按需打开设置。
建议不自动保存、不自动切换 provider/model。

### 3. ACP 协作

把现有 `Devin 接入`、`协作会话`、`任务进度` 组合为一张协作桌，包含三个区域：

- `Agent 名册`：从安全会话投影派生 Devin、Codex、ACP 客户端，显示在线状态、当前工作、
  实际模型与最近活动；不伪造 Agent 身份或能力。
- `协作链`：以“发起者 → 会话/子会话 → 任务 → 尝试 → 产物/交接”展示已有谱系，
  只在存在可靠关联时连线，不根据相同 provider/model 猜测会话关系。
- `操作区`：添加本地 Devin ACP Agent、逐次权限确认、查看任务详情、复制/保存交接、
  显式加入 Taskboard。

第一阶段继续使用现有 ACP Host、HUD、安全任务 API 和 handoff builder，不新增自动分派、
远程 Agent 注册或机器到机器自动发送。现有 Markdown 交接必须明确标注为“由用户复制/保存”，
不能冒充已完成 Agent-to-Agent transfer。

### 4. 设置

设置首页按使用目的组织，而不是按协议名组织：

- `渠道与优先级`：接入渠道、模型路由、自定义模型；
- `Agent 接入`：Codex 连接、外部客户端接入；
- `高级连接`：本地接口、协议兼容、远程访问。

`模型怎么走`、`自定义模型`、`Codex 连接`、`本地接口`、`远程访问`、`接口兼容`、
`外部接入` 的原组件和 view ID 均保留，可从设置和命令面板进入。高级连接默认折叠。

## 导航迁移

现有 16 个 view ID 暂不删除，避免破坏 localStorage、命令面板和深链接。四个 shell 入口
采用以下固定映射：

| 一级入口 | Shell view ID | 处理方式 |
| --- | --- | --- |
| 当前工作 | `work` | 复用现有 view |
| 流量观测 | `hud` | 复用并扩展为四段观测 shell |
| ACP 协作 | `collaboration` | 复用并组合 Devin 接入、会话和任务 section |
| 设置 | `settings` | 新增一个只负责导航的 shell view |

因此 `DAO_VIEWS` 增加 `settings`，总数变为 17；原有 16 个 ID 全部继续合法。旧配置与子视图
从侧边栏隐藏，但仍可由 shell、深链接和命令面板打开。

导航规则：

- 无合法持久化入口时默认打开 `当前工作`；
- 持久化的是旧隐藏 view 时，仍可直接恢复并在设置壳中高亮对应子页；
- 命令面板继续搜索全部能力，但结果文案标出所属一级入口；
- 从流量证据点击“调整路由”进入设置中的指定配置页，不在观测页直接写 priority；
- 从当前工作点击会话或任务，进入 ACP 协作桌并保持内存选中项。

## ACP 当前实现与本阶段边界

现有能力是真实可用的：

- Electron main 可通过官方 ACP SDK 和打包 stdio proxy 创建单个本地 Devin 会话；
- ACP bridge 为请求附加 main-only 会话归因，并处理摘要子会话谱系；
- HUD 会话投影展示真实模型、provider、缓存、延迟、Todo 与活动；
- task store/API 记录心跳、attempt、fallback、结果和安全产物；
- handoff builder 生成不含 prompt、Authorization、完整路径和原始 ID 的交接摘要。

本阶段不会宣称已经具备完整多 Agent 编排。以下能力不在本阶段自动实现：

- 自动把任务分派给另一个 Agent；
- 自动终止 IDE 原生会话；
- 自动发送 handoff 或修改 Taskboard；
- 根据缓存或亲和数据自动重排渠道；
- 接管 Devin 原生历史聊天；
- 新增公网控制面或未授权远程执行。

## 数据流

```text
IDE / Devin / Codex / ACP client
              │
              ▼
      Dao Flow local runtime
        ├─ route + usage facts
        ├─ HUD safe sessions
        ├─ task lifecycle
        └─ handoff artifacts
              │
              ▼
      Electron main allowlist
              │
              ▼
   Work / Traffic / ACP / Settings
```

Renderer 只接收安全投影。原始 session/job/tool ID、prompt、Authorization、完整路径、API key
和完整 endpoint 不进入 DOM、localStorage 或持久化 UI 状态。

## 组件边界

- 一级 shell 负责导航和布局，不直接解析 raw payload；
- 现有 control view 保留数据加载责任，逐步提取可组合 section；
- Agent 名册、协作链、流量摘要使用纯投影模型，输入是已规范化安全数据；
- 设置壳只导航到旧配置组件，不复制其写入逻辑；
- 跨页选择只在 React 内存中传递安全 selection token，不将原始 ID写入 URL/localStorage。

## 空态与错误

- 没有活跃 Agent：说明观测正常且当前无工作，提供“添加 Agent”和“查看历史”；
- 观测源离线：保留最后一次安全数据，明确显示自动重试；
- 会话与任务无法可靠关联：分别展示，不画虚假连线；
- ACP Host 不可用：解释缺少的本地条件，现有路由和观测不受影响；
- 设置页失败：不影响工作桌与只读观测。

## 验收

- 侧边栏日常只显示四个一级入口；
- “模型怎么走”不再作为一级入口，但设置和命令面板仍可达；
- ACP 协作桌能在同一页面看到 Agent、会话、任务、尝试、产物和显式交接动作；
- 当前工作可以 drill-in 到 ACP 协作桌的对应安全条目；
- 最近请求直显模型、渠道、缓存、亲和、延迟和 fallback；
- 没有自动 priority/provider/model 变更；
- 没有新增未授权远程能力；
- 现有 16 个 view ID 全部保留，仅新增 `settings`；写操作权限边界和 Devin 插件不被破坏；
- 单元测试覆盖导航可达性、隐藏视图恢复、协作链不猜关联、安全 DOM 与空态；
- Desktop 全量测试、typecheck、lint 和 build 通过。

# Dao Flow 运行运维健康桌设计

## 状态

已批准执行。Dao Flow 的运维边界是本机 Agent 通信与运行控制，不是通用服务器运维平台。

## 目标

在现有“流量观测”分区增加一个只读“运行健康”视图，回答：本机 runtime 是否在线、观测源是否新鲜、上游渠道是否有异常、当前是否有工作、Taskboard 是否可用。它只消费已有安全投影，不新增远程能力，不自动修复或改路由。

## 边界

- 复用 Electron `getRuntimeStatus`、`getTaskboardSnapshot` 与现有 `/origin/hud/snapshot`。
- 不新增 runtime endpoint、MCP/A2A、隧道、VPS/SSH 或任意命令执行。
- 不自动切换 provider/model，不改变用户规定的 priority。
- 不持久化或渲染 prompt、Authorization、完整路径、原始 session/job/request ID。
- “健康”只表达当前安全事实的可用性，不等于上游业务成功保证。

## 模型

`operationsModel` 接收已归一化的 Desktop status、HUD snapshot、Taskboard snapshot 和当前时间，输出稳定的 `OperationsHealthSnapshot`：

- `overall`: `good | warn | bad | unknown`
- `items`: runtime、观测源、上游渠道、Agent 会话、请求观测、Taskboard 六个健康项
- 每项只有安全标签、状态、计数、最近观测时间和解释，不携带原始标识或配置值

判定规则：runtime 离线或观测源失败为 `bad`；数据源陈旧、渠道熔断/降级、会话告警、Taskboard 断开为 `warn`；没有请求/会话是“暂无样本”而不是故障；所有输入缺失时为 `unknown`。

## UI

在 `流量观测` 分区新增“运行健康”页签。页面按以下顺序展示：

1. 总体状态和最近刷新时间。
2. 六项健康行：状态、直白解释、计数和可导航入口。
3. 明确的安全说明：这里只读观测，不自动改路由或执行修复。

刷新复用现有三类读取并行执行；单个数据源失败不遮蔽其他事实，页面保留“部分可用”状态。

## 验收

1. 模型对健康、陈旧、缺失、断开和无样本状态稳定投影。
2. 页面只调用现有 runtime status、HUD snapshot、Taskboard snapshot，不发新的 endpoint 或写请求。
3. 流量观测导航能到达运行健康，其他四个页签行为不变。
4. UI 不显示 prompt、Authorization、完整路径或原始内部 ID。
5. Desktop 全测、typecheck、lint、build、arm64 打包和实机运行健康页验收通过。
6. 对当前工作、流量观测、ACP 协作、设置四个一级桌做模块级质检并记录剩余风险。

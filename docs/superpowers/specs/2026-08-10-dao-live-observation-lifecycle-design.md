# Dao 实际流量观测与会话退役设计

- 日期：2026-08-10
- 状态：沿用用户“按最优路径持续推进”的授权实施
- 范围：Dao Flow Desktop、Devin ACP 薄连接器、Web HUD/原生 HUD 展示

## 1. 问题与实证

本机同时存在两个健康的 Dao 运行时：IDE/Devin 实际流量进入 `127.0.0.1:8955`，Dao Flow App 因端口占用另起运行时。实际流量侧当前有 Devin/Codex 会话、缓存请求样本和非零命中率，App 侧只有 Codex 历史会话且没有最近请求。因此缓存和 Devin 会话缺失是数据源分裂，不是缓存指标或 React 格式化错误。

Web HUD 还存在两个产品语义问题：过期的 active/requestInFlight 标记可让无新活动的会话长期保留；“任务可靠性”未说明它只观测登记到任务存储的长任务，也未解释心跳、尝试、fallback 和结果分别代表什么。

## 2. 目标

1. Dao Flow 只读展示当前真正承接 IDE 请求的本地 Dao 运行源；过渡期不得丢失旧运行时中的 Devin 会话和缓存样本。
2. 新启动的 Devin ACP 会话优先发现并使用健康的 Dao Flow Desktop 本地端点；Desktop 不在线时保持既有降级路径。
3. 会话以可信活动时间为准：超过 5 分钟无活动立即退出当前工作；历史数据不删除。
4. 将“任务可靠性”改成直白的“长任务运行情况”，明确数据源、指标含义及其与聊天会话的区别。
5. 保持用户配置的 provider/model priority，不做自动切换、评分重排或远程能力扩张。

## 3. 选定方案

采用“Desktop 优先接入 + 过渡期只读观测汇合”。

- Devin 薄连接器优先探测 Desktop main-only endpoint descriptor 指向的 loopback Dao。显式 `DAO_ACP_API_URL` 仍拥有最高优先级；Desktop 不健康时回退既有注入地址和默认入口。
- Desktop 的 HUD snapshot 读取在 main 进程中从固定的 Desktop/既有 Dao loopback descriptor 发现候选，只接受严格本机 HTTP 地址和合法 HUD v1；以真实活跃会话、最近请求和生成时间选择当前观测源。
- 只有精确白名单中的运行事实 GET 使用该只读观测选择：HUD snapshot、usage、alerts、failure-stats、traces。配置、审计、备份、Taskboard、路由建议与所有写操作仍由 Desktop 自己的受控运行时处理，避免把“看见实际流量”误扩张成隐式配置同步。
- Web HUD 和 Desktop HUD 都显示当前数据端口与生命周期说明，使过渡期来源可解释。

## 4. 会话生命周期

| 最近可信活动                                | 实时结果                   |
| ------------------------------------------- | -------------------------- |
| 不超过 5 分钟且存在 active/requestInFlight | 运行中                     |
| 超过 5 分钟                                | 退出当前工作，保留底层历史 |
| 明确 stopped/closed/completed/cancelled     | 立即退出当前工作           |

`observedAt` 不是活动证据。warning/verification failure 不得绕过 15 分钟上限。当前工作的“我知道了”只关闭安全指纹对应的待处理项，不删除会话。

## 5. 长任务展示语义

标题改为“长任务运行情况”。固定说明：这里只展示 Dao 任务存储登记的长任务，不等同于聊天会话监控。

展示三个摘要：

- 运行中：`queued`、`running`
- 需要处理：`failed`、`timed_out`、`detached`、`transport_lost`
- 已结束：`succeeded`、`cancelled` 及其他终态

每个条目继续展示最近心跳、尝试次数、fallback 次数和最终结果，并用直白标签解释这些是任务执行事实，不是抽象“可靠性分数”。

## 6. 安全边界

- endpoint descriptor 和完整文件路径只在主进程/连接器内使用，不进入 renderer、DOM 或普通日志。
- 只接受 `http://127.0.0.1:<port>`，拒绝用户名、密码、query、hash、非根路径、localhost 别名和非 loopback 地址。
- 观测选择只发 GET，不携带 prompt、Authorization 或任意 renderer 提供的 URL。
- 不合并或持久化原始 session/job ID，不删除历史。
- 不改变 provider/model priority，不自动迁移配置，不新增远程连接。

## 7. 验收

- 8955 有真实 Devin/缓存而 Desktop 自身为空时，App HUD/当前工作可见 Devin 与缓存事实。
- Desktop 开始承接新流量后，观测源可回到 Desktop，且不会被更旧的外部快照覆盖。
- 明确环境变量覆盖 Desktop 自动发现；Desktop 不健康时 Devin 仍按既有路径启动。
- 过期 active/requestInFlight 会话超过 5 分钟后从当前工作退出；Web HUD 可保留有限的最近状态用于历史回看。
- Web 和 Desktop 不再出现未解释的“任务可靠性”；摘要分类和解释文案有测试。
- 根测试、Desktop Vitest/typecheck/lint/build 通过；实际 App 重打包后完成本机验证。

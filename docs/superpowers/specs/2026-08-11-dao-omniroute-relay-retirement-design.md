# Dao Flow 五分钟退役与路由接力单设计

- 日期：2026-08-11
- 状态：已完成实现、独立规格/质量复审与 macOS 实机验收
- 参考：OmniRoute Combo、Health、Resilience 与 routing decision 设计

## 1. 目标

Dao Flow 的定位是位于本地 IDE 与 API 服务之间的本地中间桌。它既要让仍在进行的工作可见，也要把一次请求将按什么顺序接力、为什么跳过某个渠道、失败后实际转向哪里说明白。

本阶段把两个任务放在同一个目标内完成：

1. 当前工作中的会话与任务只要超过五分钟没有可信活动，就退出实时桌；旧告警不能因为“需要处理”而无限停留。
2. 吸收 OmniRoute 的 Combo/Health 可解释性，新增“路由接力单”：严格保留用户规定的 priority，把每一跳的资格、跳过原因和恢复倒计时直白展示；不吸收自动评分重排。

## 2. 方案选择

### A. 路由接力单（采用）

复用现有发送前检查与真实路由证据。在预计路线中按规定 priority 列出每一跳，并明确显示：

- 规定优先级；
- 当前是否可尝试；
- 不可尝试时的原因；
- 熔断时距离可再次尝试还有多久；
- 本次预计尝试顺序；
- 真实请求发生后的尝试、跳过、回退和最终结果。

它吸收 OmniRoute Combo 的“接力链”和 Health/Resilience 的“状态与恢复窗口”，但不复制自动 Combo。

### B. 主动 Provider Doctor（暂缓）

由用户点击后向渠道发合成请求，可测真实连通性，但会产生真实用量和额外副作用。本阶段只读取已有路由事实与熔断事实，不把主动探测作为默认动作。

### C. Auto-Combo 自动重排（不采用）

OmniRoute 会根据健康、配额、成本、延迟、成功率和缓存亲和等因素自动重排候选。Dao Flow 只把这些作为可观测参考；真实尝试顺序继续以用户规定的 priority 为主，不自动切换 provider/model。

## 3. 五分钟退役语义

- 会话的可信活动时间来自安全投影后的最新活动时间；任务来自更新时间、心跳或完成时间中的最新值。
- 活动年龄 `> 5 分钟` 即从“当前工作”关闭，不再进入“运行中”或“需要我处理”。恰好五分钟仍在实时窗口。
- terminal 会话立即退出实时桌；没有可信活动时间的对象不能被当作刚刚活跃。
- HUD 可以在有限历史窗口内保留已退役事实，但必须标为非实时，且不计入当前工作。
- 不删除源数据、不停止 IDE/远程进程、不修改 Taskboard 状态。

## 4. 路由接力单数据契约

现有 `route-preflight` 安全响应继续返回：

- `configuredOrder`：规定顺序；
- `dispatchOrder`：本次预计实际尝试顺序；
- `excluded`：不可尝试的渠道；
- `advisoryOrder`：仅供比较的建议；
- `budget` 与 `warnings`。

对 `excluded` 增加有界、只读字段：

- `remainingMs`：熔断剩余毫秒数，非熔断或无可信值时为 `null`；
- `circuitCategory`：只允许 `authentication`、`balance`、`permission`、`model_not_found`、`rate_limit`、`transient`、`upstream_5xx`、`network`、`unknown`，不传原始上游错误正文；
- `recoveryAt` 不直接持久化，由 renderer 根据当前时间和 `remainingMs` 生成相对文案，避免新的稳定标识。

字段不能包含 prompt、Authorization、完整路径、原始 session/job/request ID 或原始上游错误正文。

## 5. 页面行为

“发送前检查（可选）”继续由用户显式触发，不自动 POST。结果先给一句结论，然后展示“路由接力单”：

- 每个规定渠道占一行，顺序不可拖拽；
- 可用项显示“可尝试”；
- 被排除项显示“本次跳过 · 原因”；
- 熔断项用直白中文说明凭据、余额、权限、模型不存在、限流、上游异常或网络故障，并追加“约 N 秒/分钟后可再尝试”；
- 预计第一跳明确标记；
- 参考建议仍置于折叠的比较信息，不影响接力顺序。

真实请求仍由现有“最近请求走了哪里”证据时间线展示。接力单解释发送前事实，证据时间线解释发送后事实，两者不混为自动路由控制器。

## 6. 安全与范围边界

- 保持现有 priority，不自动重排、不自动保存配置。
- 不新增未经授权的远程能力、公共入口、隧道、Webhook、MCP/A2A 控制面。
- 不引入 OmniRoute 的提示压缩、账号池、免费渠道目录、TLS stealth 或主动健康探测。
- 不保存或展示 prompt、Authorization、完整路径和原始 session/job/request ID。
- 复用现有 localhost IPC 白名单与现有 preflight endpoint；不新增 endpoint。

## 7. 测试与验收

### 退役

- 新鲜 running/attention 会话与任务仍可见。
- 超过五分钟的 running、warning、blocked、failed、detached、timed_out 均退出当前工作。
- 本地时钟推进即可触发退役，无需等待下一次远端快照。
- HUD 历史保留不会把已退役对象重新送回当前工作。

### 路由接力单

- priority 顺序与 `configuredOrder` 完全一致。
- 可用、停用、缺失、不兼容、熔断都有直白状态。
- 熔断剩余时间有限、非负，renderer 不读取原始 circuit 对象。
- 发送前检查不会调用 provider、不会修改 priority。
- 真实证据仍保持 attempt/fallback/skip/outcome 顺序。
- focused/full tests、typecheck、lint、build、macOS 打包安装和真实 App 验收通过。

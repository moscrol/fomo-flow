# Dao Flow 请求预演与决策中心设计

- 日期：2026-08-10
- 状态：已实现并通过本地运行态验收，Taskboard DAOFLOW-6 已进入 `in_review`
- Taskboard：DAOFLOW-6

## 1. 定位

Dao Flow 位于模型 API 服务层与本地 IDE、Codex、Devin、ACP Agent 之间。本阶段同时加强两种能力：

1. **网关强化（A）**：把候选生成后的资格判断、预算判断、建议评分与实际尝试顺序收进同一个纯路由规划模块，使预演和真实请求共用事实与规则。
2. **Agent 控制面（B）**：提供“发出前看看”“需要你决定”“这次为什么走这里”三个直白组件，让用户理解和人工处理路由问题。

本阶段不把 Dao Flow 变成远程 Agent runtime，不复制 IDE，不执行 shell，不增加 MITM，不自动切换 provider/model，也不自动保存路由 priority。

## 2. 已有能力与缺口

已有实现已经提供：

- 按用户配置生成的实际候选顺序；
- 显式请求预算与 `strict` / `cheapest` 处理；
- 只读 advisory profile 与评分；
- routing decisions、traces、alerts、failure stats、usage；
- Electron 本地控制面 allowlist 与安全展示投影。

当前缺口是：

- 没有“不调用上游”的真实请求预演；
- 预算、候选资格、建议评分和真实尝试的解释散落在路由器中；
- 没有把可行动的路由问题聚合成收件箱；
- 没有把预演、过滤、尝试、回退、结果串成一条证据时间线；
- UI 只能查看历史快照，不能在发送前理解当前配置会发生什么。

## 3. 方案选择

### 方案 A：Renderer 根据历史快照推测

改动最小，但历史数据可能过期，且前端会复制预算、熔断和候选资格逻辑。预演与真实调度可能给出不同答案，不采用。

### 方案 B：共享纯路由规划模块

由真实调度与预演共同调用一个深模块。调用方只提供候选和安全请求事实，模块返回完整规划结果；预演不触发 provider。准确性、局部性和可测试性最好，采用。

### 方案 C：真实路由进入 dry-run 后中途阻断

看似复用最多，但容易修改健康计数、缓存亲和、trace、用量或其他运行态，副作用难以证明为零，不采用。

## 4. 核心模块与 seam

新增 `route_planner` 深模块，外部 seam 只暴露一个主接口：

```js
createRoutePlan({
  candidates,
  providers,
  circuits,
  request,
  profile,
  budget,
  cacheAffinityProvider,
  now
}) -> RoutePlan
```

调用方必须先按现有配置生成候选；规划模块负责：

- 保留“配置 priority / legacy random”产生的基线顺序；
- 标记 provider 缺失、禁用、熔断、能力不兼容等排除原因；
- 计算预算估算、`strict` 拒绝或显式 `cheapest` 覆盖；
- 计算 advisory 分数和建议顺序，但不让建议顺序影响实际调度；
- 返回实际预计尝试顺序、配置顺序、排除项、预算事实、建议事实与警告；
- 输出有界、脱敏、可序列化的数据，不包含请求正文或凭据。

真实路由器仍负责：

- 解析请求、生成配置候选、调用 provider、记录真实结果；
- 将规划模块返回的 `dispatchOrder` 用于实际尝试；
- 只有请求明确指定 `x-dao-budget-fallback: cheapest` 且预算规则命中时，允许规划模块把最便宜候选移到首位；
- 其他情况下 priority 模式的实际顺序必须与用户配置一致；random 模式保持既有 legacy 行为。

删除该模块会迫使预演与真实调度分别复制资格、预算和解释逻辑，因此该 seam 具有足够深度。

## 5. RoutePlan 安全契约

```ts
type RoutePlan = {
  planId: string
  createdAt: string
  expiresAt: string
  mode: 'preflight' | 'dispatch'
  model: string
  profile: string
  strategy: 'priority' | 'random'
  configuredOrder: RouteCandidateFact[]
  dispatchOrder: RouteCandidateFact[]
  excluded: RouteExclusion[]
  advisoryOrder: RouteCandidateFact[]
  budget: {
    status: 'not_requested' | 'unverified' | 'within_cap' | 'strict_rejected' | 'cheapest_override'
    capUsd: number | null
    fallback: 'strict' | 'cheapest' | null
    overBudgetFallback: boolean
  }
  warnings: RouteWarning[]
}
```

每个候选只允许 provider、model、source、actualPriority、advisoryRank、有限数值因子、估算成本和固定枚举状态。错误原因必须映射为固定分类与有界安全文案。

禁止进入 RoutePlan：

- prompt、messages、tool arguments、system prompt；
- Authorization、API key、cookie、完整 headers；
- 完整路径、workspace root；
- 原始 session ID、job ID、request ID、conversation key；
- provider 原始错误正文。

## 6. 请求预演

新增本地端点：

```http
POST /origin/ea/route-preflight
```

请求体仅允许：

```json
{
  "model": "model-uid",
  "profile": "balanced",
  "budgetUsd": 0.2,
  "budgetFallback": "strict",
  "inputTokens": 12000,
  "maxOutputTokens": 4096,
  "stream": true,
  "usesTools": true,
  "thinkingEnabled": false,
  "reasoningEffort": "medium"
}
```

约束：

- model/profile/枚举字段白名单；数值字段有上下限；请求体小于 16 KiB；拒绝未知字段；
- 不接收 messages、prompt、headers、路径或任意对象；
- 端点只解析当前本地配置和内存健康事实，绝不调用 provider、探活接口或远程服务；
- 不修改 route、provider、priority、亲和、熔断、用量或成功/失败指标；
- 返回 RoutePlan 和明确文案：“只是预演，不会发送请求或改变优先级”。

每次预演在内存中保留一个 5 分钟、一次性的安全关联记录。真实请求若在有效期内与 model/profile/预算/能力元数据完全匹配，可消费该记录并把 `planId` 写入证据时间线；没有可靠匹配时显示“未关联预演”，不猜测。关联行为不得改变调度。

## 7. 决策收件箱

新增端点：

```http
GET  /origin/ea/decision-inbox?limit=50
POST /origin/ea/decision-inbox/:id/ack
POST /origin/ea/decision-inbox/:id/snooze
```

收件箱从 RoutePlan 和真实结果生成有界、安全、可行动的事项：

- 严格预算拒绝；
- 所有候选都被排除或实际全部失败；
- 配置首选连续不可用并多次回退；
- advisory 首选与配置首选持续明显分歧，提示用户人工比较；
- 价格未知导致预算无法验证；
- 预演与实际资格事实发生变化。

同类事项按稳定 fingerprint 去重并累计次数。列表最多 200 条，默认保留 30 天。

持久化仅保存 fingerprint、固定分类、状态、计数和时间；不保存 RoutePlan 全文或请求数据。写入使用本地原子文件。`ack` 与 `snooze` 只改变收件箱状态，不执行配置、路由、重试、探活或远程动作。

UI 动作只包括：

- 已知晓；
- 稍后提醒；
- 打开路由配置；
- 打开预算设置；
- 查看对应证据。

## 8. 路由证据时间线

新增端点：

```http
GET /origin/ea/route-evidence?limit=50
```

每条时间线记录一个有界证据包：

1. 预演创建或“未预演”；
2. 用户配置顺序；
3. 资格过滤与固定原因；
4. 预算判断；
5. advisory 建议顺序；
6. 实际尝试、跳过与回退；
7. 最终选中、预算拒绝或全部失败；
8. 有限的 latency、status、cost/cache 汇总（仅已有安全事实可用时）。

证据包最多保留 200 条、24 小时，默认只驻留内存。使用 Dao 生成的 opaque evidence ID；不复用或显示 IDE/session/job 原始 ID。真实尝试结果只能追加，不能反向修改已经作出的 RoutePlan。

## 9. Electron 决策中心

在“工作台”组新增 `decisions` 视图，标题为“决策中心”，包含：

1. **发出前看看**：模型、场景、预算的简单表单；结果明确区分“规定顺序”“预计实际尝试”“参考建议”“不会发生什么”。
2. **需要你决定**：按严重度与时间展示人工事项，提供已知晓、稍后提醒和导航按钮。
3. **这次为什么走这里**：纵向时间线解释过滤、预算、尝试、回退和结果。

Renderer 只消费安全投影。raw payload 的校验、枚举映射、文本限长和脱敏集中在纯 TypeScript 模型中。视图轮询必须有 sequence/abort guard，避免旧响应覆盖新选择。错误态保留上一次安全数据，并明确自动重试。

Electron allowlist 使用精确 pathname：

- 精确允许上述 GET/POST；
- 拒绝相似路径、未知 method、GET body、超大 body 和跨 origin URL；
- 收件箱写入不复用宽泛配置写前缀。

## 10. 行为与隐私不变量

1. priority 模式下，未指定显式 `cheapest` 预算覆盖时，规划前后和实际请求的首候选与配置顺序一致。
2. advisory 只用于解释和比较，不修改候选数组，不写配置。
3. preflight 的 provider 调用次数、用量、健康、熔断、亲和和审计配置动作增量均为零。
4. 收件箱操作不触发路由、探活、重试或配置保存。
5. 不新增公网监听、relay、云同步、远程控制或任意文件读取。
6. 所有 DOM、日志和持久化状态均不得出现 prompt、Authorization、密钥、完整路径或原始 session/job/request ID。
7. 既有 routes/providers/observability/collaboration/advanced views 保持可达。

## 11. 错误处理

- 无效 preflight 输入返回结构化 400；未知 model 返回 404；runtime 未就绪返回 503；无候选返回成功的阻断计划而不是伪造候选。
- preflight 内部异常不得降级为真实调用。
- 收件箱持久化失败时列表仍可只读展示，动作返回可恢复错误，不丢失内存证据。
- 证据时间线中的 provider 错误只保留固定分类、HTTP 状态和有界摘要。

## 12. 验收

### Planner parity

- priority、random、fallback、disabled、circuit、strict budget、cheapest budget 的预演与真实调度使用同一规划结果；
- 默认 priority 绝不被 sticky 或 advisory 重排；random 保持 legacy 顺序；
- 预演不产生任何 provider 调用或运行态写入。

### Runtime 与安全

- 端点 schema、大小、method 和 exact path 测试；
- inbox 去重、计数、ack、snooze、过期和原子恢复测试；
- evidence 关联、未关联、时间顺序、上限和隐私测试；
- prompt、Authorization、API key、绝对路径和原始 ID 泄漏回归测试。

### Desktop

- 预演表单、规定顺序/建议顺序分栏、空态、错误态和竞态测试；
- 收件箱人工动作与导航测试，断言无配置写入；
- 证据时间线直白文案和键盘可访问性测试；
- 所有旧视图仍可通过侧栏与命令面板进入。

### 完整检查

- focused Node tests；
- root relevant/full tests；
- desktop Vitest、typecheck、ESLint、Vite build、Electron bundle；
- root desktop smoke；
- `git diff --check`；
- 只提交本阶段文件，不覆盖或带入用户其他脏改动。

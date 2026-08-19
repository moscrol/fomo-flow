# Dao Auto-Routing Profile 设计

- 日期：2026-08-09
- 状态：已实现并完成审查修正（advisory-only 路由观测）

## 目标

吸收 OmniRoute Auto-Combo 中最适合 Dao ACP 工作台的三项能力，但把“自动选择”降级为可观测建议：

1. 面向任务的路由分析档案：`balanced`、`coding`、`fast`、`cheap`、`reliable`、`offline`。
2. 安全、可解释的路由决策快照：候选渠道、档案、分数因素和最终命中渠道。
3. 请求级成本预算：预算上限与“严格拒绝 / 选择最便宜可用渠道”策略。

本切片只改本地 Dao 路由和 Electron 展示，不接入 OmniRoute 运行时、Provider 目录、远程模式、Fusion、Pipeline、Memory 或 MITM/TProxy。分析档案默认只生成建议数据，绝不覆盖用户规定的优先级。

## 现状与约束

- `vendor/外接api/core/channel_scorer.js` 已有健康、延迟、成本、缓存亲和、稳定性、配额、任务契合、优先级八因子评分。
- `dao_router.js` 使用 scorer 生成脱敏 advisory 快照；真实 `priority` 继续保持确定性的配置顺序，`random` 保持既有随机顺序。
- `custom_model_registry.js` 当前只持久化 `priority|random` 两种策略；桌面 `CustomModelsControlView` 也只显示这两项。
- 用户明确要求路由亲和不自动生效，因此本切片不得把 scorer 或历史会话亲和接到 `priority` 的实际候选排序链上；所有真实请求默认仍按 `channelPriority` 顺序尝试。
- `budget.js`、`context_strategy.js` 和 `tool_strategy.js` 已承担 token 预算、历史裁剪、工具 schema 压缩和 checkpoint，不在此切片重写。
- Electron 控制 IPC 只允许 loopback `/origin/*` allowlist；任何新读端点必须加入同一 allowlist，不能把远程 URL 直接交给 renderer。
- 不记录 prompt、完整消息、API Key、完整路径或原始会话 ID。决策快照只能保存脱敏 provider/model、profile、factor 数值和有限时间戳。

## 设计

### 1. Profile 纯模块（只作为分析镜头）

新增一个无副作用的 profile 模块，负责：

- 解析并校验 profile 名称；未知值回退 `balanced`。
- 为每个 profile 返回冻结的 scorer 权重；所有权重归一化为 1。权重只用于生成“如果采用该档案会如何排序”的观察结果。
- 解析请求级预算：正数 USD 上限、`strict` 或 `cheapest` fallback；非法值忽略，不改变持久配置。
- 不读取 prompt 内容，不访问网络，不修改路由状态。

推荐权重意图：

| Profile    | 主导因素                                      |
| ---------- | --------------------------------------------- |
| `balanced` | 健康 + 延迟 + 缓存亲和的均衡选择              |
| `coding`   | 任务契合 + 稳定性 + 健康                      |
| `fast`     | p95 首可见延迟 + 健康                         |
| `cheap`    | 声明价格和已知成本                            |
| `reliable` | 健康 + 稳定性 + 熔断状态                      |
| `offline`  | 配额余量 + 健康；无配额数据时保持中性，不猜测 |

Profile 不参与真实候选排序，不改变协议、请求内容、工具权限、fallback 安全规则或用户配置的优先级。

### 2. 路由集成与人工选择

- 不扩展真实 `channelStrategy` 的自动行为；`priority` 仍按配置顺序（不自动插入 sticky 亲和），`random` 保持现有随机顺序。
- scorer 只对当前候选池生成 advisory ranking，快照明确标记 `mode: "advisory"`，不会改变 dispatcher 的候选数组。
- 桌面端允许用户手动“置首”或调整 `channelPriority`；该动作才是改变真实路由顺序的唯一入口。
- 熔断候选继续为 0 分，所有候选都不可用时保留现有可读错误。
- 成本因子只使用 provider 显式声明的 `pricing.inPer1k/outPer1k`；缺价维持中性。
- 分析 profile 可以在观测卡片中手动切换，用于比较不同权重镜头；不写入模型的真实路由策略。旧配置继续默认为 `priority` 和无预算。

### 3. 请求级预算

在请求进入真实 dispatch 前解析 request-local budget；默认无 budget，因此不改变优先级：

- `budgetCap`：正数 USD 上限；缺失表示不设硬上限。
- `budgetFallback=cheapest`：仅当用户显式设置预算且所有候选超限时，选择最便宜的健康候选并记录 `overBudgetFallback`。
- `budgetFallback=strict`：若所有候选超限，返回 HTTP 402 与可读的 `DAO_BUDGET_EXCEEDED` 帧，不调用上游。

估算成本使用现有 pricing 和 token 观测；缺少可靠 token 或价格时不得伪造精确金额。预算拒绝必须发生在上游请求之前。

### 4. 决策快照与桌面展示

新增一个 bounded、内存态的最近路由观察快照接口，返回：

```json
{
  "id": "route-abc-1",
  "at": "2026-08-09T08:00:00.000Z",
  "model": "MODEL_DAO",
  "profile": "coding",
  "mode": "advisory",
  "selected": { "provider": "sibling", "model": "gpt-5.6-sol" },
  "candidates": [
    {
      "provider": "sibling",
      "model": "gpt-5.6-sol",
      "source": "primary",
      "actualPriority": 1,
      "advisoryRank": 1,
      "advisoryScore": 0.82,
      "factors": {
        "health": 1,
        "latency": 0.76,
        "cost": 0.5,
        "cacheAffinity": 1,
        "quota": 0.7
      }
    }
  ],
  "channelStrategy": "priority",
  "budget": {
    "capUsd": null,
    "fallback": null,
    "budget_override": null,
    "overBudgetFallback": false,
    "status": "not_requested"
  },
  "outcome": {
    "status": "selected",
    "provider": "sibling",
    "model": "gpt-5.6-sol",
    "actualPriority": 1,
    "failureCount": 0,
    "failureClass": ""
  }
}
```

限制：最多保留 20 条、每条最多 16 个候选、字符串字段截断、只保留最近 30 分钟；失败和未选候选也只保留因素摘要。

Electron 复用现有 `ObservabilityControlView` 或 `RoutesControlView` 的 control primitives，增加“路由决策”卡片；profile 切换只刷新建议端点，不重复刷新其它观测数据；不新增 renderer 直连能力，不展示原始请求。

### 5. IPC 与错误边界

- 新接口只读，路径加入 Electron 的 exact read allowlist；请求仍必须是 `127.0.0.1` 同源 `/origin/*`。
- renderer 只接收已校验的快照；快照解析异常时显示“暂无决策数据”，不让页面崩溃。
- 预算值越界、profile 未知、候选成本缺失均采用安全回退并写入诊断原因。
- 不改动远程访问 allowlist；VPS/remote context 另立切片。

## 已实现的 operator 契约

- API：`GET /origin/ea/routing-decisions?profile=<id>&limit=<n>`，返回 `{ ok: true, decisions }`；profile 未知回退 `balanced`，limit 限制在 1..20。
- 每条记录标记 `mode: "advisory"`，最多 16 个候选，内存 TTL 30 分钟；只保存脱敏 provider/model/source、因子、实际优先级、建议排名、预算状态和 outcome。
- `priority` 的实际尝试顺序仍由用户配置决定，profile 只重算显示；旧 `random` 和显式有效预算 `cheapest` 是唯一自动例外。
- 预算覆盖同时记录 `budget_override: "cheapest"` 与 `overBudgetFallback: true`；未知价格/Token 时标记 `unverified`，不自动改序；strict 全部超限时在上游调用前返回 HTTP 402 `DAO_BUDGET_EXCEEDED`。
- 渠道顺序只能在自定义模型编辑器中通过 `置顶`、`上移`、`下移`修改草稿，并由 `保存并同步` 持久化；单独点击排序按钮不会发写请求。

## 测试策略

1. profile 纯函数测试：六个 profile 权重、未知 profile 回退、预算解析和严格/宽松策略。
2. scorer 测试：同一候选池在 fast/cheap/offline 下排序符合权重意图；缺价不打分为免费。
3. router 测试：priority/random 旧行为不变；profile 只生成 advisory 排名且不重排真实候选；熔断候选不会被建议；strict 超预算不调用 provider。
4. snapshot 测试：上限、TTL、字段脱敏、无 prompt/密钥/完整路径。
5. desktop 测试：手动优先级调整、决策卡片渲染、坏 payload 空态；typecheck、lint、desktop test、root smoke。

## 非目标

- 不复制 OmniRoute 的 19 种策略。
- 不实现 Fusion/Pipeline、多模型并行或 judge。
- 不接入新的 Provider、OAuth、向量数据库、重型压缩模型或 TPROXY。
- 不把决策快照写入磁盘或远端服务。

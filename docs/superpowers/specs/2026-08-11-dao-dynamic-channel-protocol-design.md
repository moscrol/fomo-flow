# Dao 动态渠道协议识别设计

## 目标

保持 `dao-opus-5` 的首选渠道仍为 `cccc`，先将该通道协议显式改为 `openai-chat`，再让 Dao 在运行时依据渠道已经探测到的协议能力选择兼容协议，避免“模型声明 Anthropic、渠道只支持 OpenAI Chat”这类错配。

本功能只选择请求协议，不切换 provider/model，不改变用户规定的渠道 priority，不建立新的远程探测，也不伪造缓存命中。

## 已确认事实

- `dao-opus-5` 当前首选渠道是 `cccc`，上游模型为 `claude-opus-5`。
- 自定义模型声明 `anthropic`，但 `cccc.supportedProtocols` 只有 `openai-chat`。
- 该 Devin 会话连续写入缓存但读取为零；相同模型在声明支持 Anthropic 的 `ccc` 上存在真实 cache-read。
- 现有 `_resolveTargetProtocol` 会无条件优先使用 route/channel 的显式协议，即使渠道已经声明不支持该协议。

## 方案

### 第一阶段：立即修正 cccc 通道

只修改 `dao-opus-5.channels` 中 provider 为 `cccc` 的条目：

- `protocol` 设为 `openai-chat`；
- provider、upstream model、reasoning 配置与通道顺序保持不变；
- 不把 `ccc` 或其他渠道置顶；
- 同步更新实际运行的 legacy Dao 配置与 Desktop 私有配置中存在的同一通道；
- 写入前保留私有权限备份，写入后通过只读运行态确认热加载。

如果 Desktop 配置中不存在 `cccc` 通道，则不凭空新增或重排，只修改实际存在的记录。

### 第二阶段：能力感知的协议解析

新增可独立测试的纯解析边界。输入为：

- channel-level 显式协议；
- route/model-level 显式协议；
- provider `protocol` / `type`；
- provider 已有 `supportedProtocols`；
- completion path 与模型名等旧推断事实。

解析优先级：

1. channel-level 协议存在且被渠道能力支持；
2. route/model-level 协议存在且被渠道能力支持；
3. 渠道已经探测到的兼容协议；对 `openai-compatible` 且只支持 Chat 的渠道选择 `openai-chat`；
4. 渠道没有能力数据时才沿用现有显式配置与旧推断，以保持未知渠道兼容性。

当显式协议与非空 `supportedProtocols` 冲突时，不允许显式值越过已知能力。解析返回：

```ts
{
  protocol: 'openai-chat',
  source: 'provider-capability',
  adjusted: true,
  configuredProtocol: 'anthropic',
  reason: 'configured-protocol-unsupported'
}
```

运行时只使用 `protocol` 发请求；其余字段用于安全观测，不写回配置。

## 展示

自定义模型/路由观察中显示：

- 配置协议；
- 实际协议；
- 调整原因，例如“渠道只支持 OpenAI Chat，已按渠道能力发送”。

不展示 API key、Authorization、完整 URL、prompt、完整路径或内部请求 ID。没有调整时不增加告警噪声。

## 缓存口径

改为 OpenAI Chat 后，不再发送 Anthropic 显式 `cache_control`。缓存命中完全采用 `cccc` 上游返回的真实 OpenAI-compatible usage 字段；如果上游不返回 cached tokens，Dao 继续显示零，不推算或伪造。

验收至少观察连续两轮同会话请求：provider/model/priority 不变、实际协议为 `openai-chat`，并记录真实 cached/cache-write。是否出现命中是上游能力事实，不作为动态协议解析代码正确性的唯一条件。

## 错误处理

- 已知能力列表为空：保持旧行为，不冒险自动改协议。
- 已知能力列表只有一个合法协议：采用该协议。
- 已知能力包含多个协议：优先合法 channel 配置，其次合法 route 配置，再按 provider 类型与 completion path 选择；不得随机选择。
- 没有任何可识别协议：回退现有 `detectProtocol`。
- 协议调整不触发 provider fallback，不改变熔断、预算、亲和或 priority。

## 测试

- `cccc`：route=`anthropic`、supported=`openai-chat`，解析为 Chat 且 adjusted=true。
- `ccc`：route=`anthropic`、supported 包含 Anthropic，继续使用 Anthropic。
- channel 显式协议优先于 route，但必须被 supportedProtocols 接受。
- 无 supportedProtocols 时保持旧显式协议。
- GPT Responses、Gemini 与既有 Chat-only guard 不回归。
- 真实路由候选首项仍为 `cccc/claude-opus-5`，只改变实际协议。
- UI 只显示安全协议事实，不显示 provider secret 或完整 endpoint。

## 非目标

- 不自动选择缓存命中率最高的 provider。
- 不自动调整 `cccc` 的 priority。
- 不因缓存率低自动切换到 `ccc`。
- 不修改 Devin 插件。
- 不在每次请求前新增联网协议探测。

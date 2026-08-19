# cccc 缓存前缀连续性设计

## 目标

保持 `cccc / claude-opus-5 / openai-chat` 和用户规定的渠道 priority 不变，修复隐式缓存观测把稳定前缀恒定显示为 `2 ch` 的缺陷，并用安全摘要解释最近真实缓存为什么连续未命中。

## 边界

- 不修改已安装 Devin 插件，不重启或操作 Devin。
- 不切换 provider、model、protocol 或 priority，不伪造 cached token。
- 不重排 Devin 的 user、assistant 或 tool 历史；Dao 只允许规范化自己注入的 `dao-agent-status` 动态状态块。
- renderer、日志和持久化样本不包含 prompt、Authorization、完整路径、原始 session/job ID 或原始缓存键。

## 实现

### 隐式稳定前缀

`prompt_cache_policy.decorate()` 在 OpenAI 隐式模式下，不再因为没有显式 breakpoint 而把稳定请求体退化成 `{}`。它选择最后一个非易变消息作为稳定边界，诊断只输出：稳定前缀长度、稳定前缀哈希、system/tools 哈希、缓存族哈希和易变块数量。实际上游 body 保持原顺序和内容，只追加现有 `prompt_cache_key`。

### 连续性判定

usage 记录继续保留有界安全摘要。投影层只在同 provider、model、cache-key 和 cache-family 的相邻请求之间比较：

- `cold`：该缓存族的首条请求；
- `append-only`：上一轮规范化消息序列是本轮前缀；
- `rewritten`：同一缓存键和缓存族下，前缀不再连续；
- `family-changed`：缓存族变化；
- `unknown`：缺少足够安全证据。

压缩或重写只作为观测事实，不由 Dao 自动纠正。缓存代次在 `family-changed` 或 `rewritten` 时递增，仅在进程内安全投影中使用。

### 展示

- 渠道卡同时显示“近期 HIT”和“累计 HIT”，不再二选一隐藏累计值。
- 最近请求的前缀列显示“仅追加 / 已重排 / 新缓存族 / 待观测”和安全长度；隐式模式不再出现假的 `2 ch`。
- 连续真实 miss 且前缀为 `rewritten` 时，直白说明“上下文被重排，上游无法复用前缀”。

## 验收

- 隐式 OpenAI Chat 的稳定前缀诊断大于 2 字符，且动态状态块不进入稳定前缀。
- 装饰前后 user/assistant/tool 消息顺序和内容不变。
- 相邻请求能区分 append-only、rewritten 和 family-changed，输出不包含原始内容或缓存键。
- HUD 同时展示近期/累计命中，并对重排给出直白解释。
- 根目录相关 Node 测试、Desktop 全量测试、typecheck、lint 和 arm64 构建通过。

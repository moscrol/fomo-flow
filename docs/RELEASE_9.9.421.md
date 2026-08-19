# dao-proxy-pro 9.9.421

## Codex 热路由空响应修复

日志确认 Codex 热路由已选中 kfcoding、`gpt-5.6-sol`、Responses 和 high，但部分上游请求只返回 reasoning 后即结束。旧实现把 reasoning 当作“已输出”，随后发送空 `response.completed`；Codex 不展示该 reasoning，因此界面表现为任务无输出直接结束。

本版在反代桥接层暂存 reasoning，直到出现可见正文或工具调用才提交给客户端。上游结束时若仍无正文和工具调用：

1. 同一渠道透明重试一次。
2. 仍为空则切换到用户已配置的下一优先级渠道。
3. 所有候选都为空时返回明确 Responses 错误，不再伪装成成功。

正常请求一旦出现正文或工具调用，立即按原链路传输，不增加模型轮次。

## Codex 模型目录契约

新增 `GET /codex-hot/v1/models`，返回 Codex 使用的 `{ "models": [...] }`，普通 `GET /v1/models` 继续返回 OpenAI 标准 `{ "object": "list", "data": [...] }`。

热路由目录优先复用 `~/.codex/models_cache.json` 中当前模型的原生元数据，包括基础指令、Shell/Apply Patch 工具模式、上下文窗口、截断规则和并行工具能力，只更新当前热路由模型标识及推理强度。若本机目录暂不可用，则返回合法空目录，让 Codex 使用自身编译内置的回退模型元数据，不注入简化提示词。

## Devin 原生工具行为

Claude Opus 4.7 Medium 映射到 kfcoding 的日志显示当前为 `devin-native`：未启用 `proxy-managed`、`persistToolOutputs` 或 `deferMcpTools`。本版继续保持该行为，搜索、读取和编辑工具均由 Devin 原生工作流决定和执行，插件只负责路由、Responses 协议和推理强度传递。

## 回归覆盖

- Responses 非流式 reasoning-only 首次为空、第二次正文成功。
- Responses 流式丢弃首次空尝试的 reasoning，第二次正常完成。
- 连续两次 reasoning-only 返回明确错误且无空 `response.completed`。
- 主渠道持续为空时切换用户配置的备用渠道。
- `/codex-hot/v1/models` 与普通 `/v1/models` 分别保持 Codex/OpenAI 契约。
- 现有 Devin 原生工具策略与完整插件测试套件。

# dao-proxy-pro 9.9.399 发布说明

## 修复内容

- 完整保留 Devin 官方 system prompt、会话摘要、工具定义和工作区信息。
- 项目提示词改为单一 `<dao_project_instructions>` 区块；选择另一个项目时替换该区块，不与旧项目提示词叠加。
- `devin-native` 路由不再生成不存在的工具结果，Responses 请求只包含 Devin 实际发送的消息和工具结果。
- 继续使用 OpenAI Responses、用户选择的 `reasoning.effort`、稳定 `prompt_cache_key` 和上游前缀缓存，不增加额外模型请求或内部搜索重试。

## 日志结论

截图对应会话始终为：

```text
provider=kfcoding
model=gpt-5.6-sol
protocol=openai-responses
reasoningEffort=high
tools=25
```

缓存命中由首轮 5.6% 恢复到后续 94%–99%。错误判断同时出现在低命中和高命中轮次，因此缓存不是根因。会话输入曾从约 127,891 token 降到 82,540 token，说明 Devin 执行过官方上下文整理；插件保持 `devin-native`，不再叠加代理 checkpoint。

## 验证

- 语法检查通过。
- 项目提示词原生契约测试通过。
- Responses 原生工具透传测试通过。
- 缓存韧性测试通过。
- 核心全链路自检 347/347 通过。
- 自定义模型、模型能力、协议中转、模型反代测试全部通过。

`term-coexist.test.js` 在实机运行时因当前插件已经监听终端服务端口而不满足“端口空闲”测试前提；占用者为现有 dao 插件进程，不属于本次改动回归。

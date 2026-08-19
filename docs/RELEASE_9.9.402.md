# dao-proxy-pro 9.9.402

## 真实问题

9.9.401 的前置条件依赖 Devin system prompt 中的固定句子 `The USER does not have any active workspace.`。实机日志证明该句子并不稳定：Cortex 可能在收到 `grep_search` 后才用自己的空注册表报错，插件在请求开始时看不到该状态。

## 修复

只要请求中有经过存在性验证的工作区根目录，路由器就启用窄 `grep-only` 模式：

- 仅接管 `grep_search`、`Grep`、`GrepSearch`。
- 搜索路径必须已归一化为真实目录，并且位于本次请求的工作区根目录之内。
- `find_by_name`、`read_file`、`list_dir` 继续使用 Devin 原生执行器。
- 工作区外绝对路径、无效目录和多根歧义路径不会被插件执行。
- 不启用 `code_search`、Fast Context 或 Smart Reading。
- 本地结果通过原有工具结果续跑回送上游，不增加额外模型重试。
- `DELTA_THINKING` 仍默认隐藏。

## 验证

- 核心全链路：`347/347`。
- 工作区策略：`32` 项。
- 原有工作区集成：`15` 项。
- `grep-only` 双轮路由集成：`13` 项。
- 工作区外路径拒绝接管：通过。
- 实际 `E:\新增运行时状态机\Assets\Scripts` Grep 路径归一化与命中：通过。

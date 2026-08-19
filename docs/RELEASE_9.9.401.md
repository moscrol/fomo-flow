# dao-proxy-pro 9.9.401

## 修复内容

Devin Desktop 的 `find_by_name`、`read_file` 与 Cortex `grep_search` 并不共用同一个工作区执行器。9.9.400 已把 `Scripts` 正确归一化为项目内的绝对路径，但实机日志进一步确认：当 Devin 官方 system prompt 显示 `The USER does not have any active workspace.` 时，Cortex Grep 仍会用自己的空工作区注册表拒绝该绝对路径。

9.9.401 增加严格的 `grep-only` 兜底：

- 仅接管 `grep_search`、`Grep`、`GrepSearch`。
- 仅在 Devin 官方 system prompt 明确报告无活动工作区时启用。
- 必须能从 system prompt 或 `DAO_WORKSPACE_ROOT(S)` 取得真实存在的项目根目录。
- `find_by_name`、`read_file`、`list_dir` 继续使用 Devin 原生工具。
- 不启用 `code_search`、Fast Context 或 Smart Reading。
- 正常工作区保持完全原生；多根工作区出现歧义时不猜测路径。
- 本地 Grep 结果沿用标准工具结果续跑，不额外增加模型请求或内部重试。
- 内部推理仍不发送 `DELTA_THINKING`；可见界面不会出现代理内部重试文字。

## 验证结果

- 核心全链路：`347/347`。
- 工作区策略：`32` 项。
- 原有工作区集成：`15` 项。
- 新增 `grep-only` 双轮路由集成：`13` 项。
- `local-workspace-tools`、ACP workspace message、ACP stdio proxy：通过。
- 工具策略、上下文策略、缓存连续性、项目提示词严格替换、Webview 语法：通过。

新增集成测试验证了以下真实链路：模型返回 `grep_search` 后由插件本地执行，匹配结果进入下一轮上游消息；该工具调用不再交给空注册表的 Cortex；同一请求中的 `find_by_name/read_file/code_search` 定义仍保留，其中前两者继续走 Devin 原生执行器，`code_search` 不被代理启用；隐藏推理内容未进入 Devin 响应。

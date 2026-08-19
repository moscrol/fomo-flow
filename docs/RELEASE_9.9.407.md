# dao-proxy-pro 9.9.407

## Fast Context 原生轮次修复

实际 Devin 任务并不总会在第一轮同时生成 `grep_search` 和 `code_search`。更常见的顺序是：

1. 第一轮生成 `find_by_name + grep_search`。
2. 插件本地执行 Grep。
3. 模型在插件内部 continuation 中才首次生成 `code_search`。

第三步产生的 Fast Context 帧不属于干净的 Devin 原生工具轮次，Cortex 可能将它标记为 `Skipped`。9.9.406 只修复了第一轮已经同时包含 Grep 与 Fast Context 的情况，因此没有覆盖这条真实轨迹。

9.9.407 调整为：

- `grep-only` 模式遇到本地 Grep 与任意 Devin 原生 LSP 工具时，立即把原生工具帧交回 Devin。
- 本地 Grep 同步执行、显示，并保存结构化调用与结果，但不会启动并发上游 continuation。
- Fast Context 只能在下一次 Devin 原生工具轮次中生成和执行。
- 纯 Grep 确需内部续跑时，从该内部请求的工具列表移除 `code_search/SmartReading`，防止代理 continuation 首次发起原生语义检索。
- 不替换、不模拟、不本地实现 Fast Context；工作区索引、语义检索和结果执行仍由 Devin 原生 LSP/Cortex 负责。

## 回归验证

- 工作区策略单元与集成测试：通过。
- 真实三轮 `grep_search + find_by_name -> code_search -> 结果恢复` 回归：通过。
- 工具策略测试：通过。
- 核心路由闭环：347/347 通过。
- ACP 工作区消息与 stdio 代理测试：通过。
- 验证没有额外上游 continuation、没有原生工具占位结果，并保持本地 Grep 跨轮轨迹顺序。

## 边界

若 Devin 自身语言服务器发生退出、SIGTERM、Reload Window 或 RevertToCascadeStep，原生 Fast Context 仍可能被宿主取消。插件已消除自身制造的 continuation 竞态，但不会替代或强制重启 Devin 的原生索引服务。

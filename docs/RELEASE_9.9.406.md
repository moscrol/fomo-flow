# dao-proxy-pro 9.9.406

## Fast Context 原生执行竞态修复

真实日志确认 `code_search` 一直保留在上游工具列表中，插件也把单独的 Fast Context 调用标记为 `lspSide=1` 交给 Devin。问题出现在模型同一轮同时调用本地 `grep_search` 和原生 `code_search` 时：旧逻辑为了完成本地 Grep，会暂存整批原生调用并进行内部上游续跑。如果续跑没有再次生成 `code_search`，第一次调用不会抵达 Devin，界面最终显示 `Skipped`。

9.9.406 改为：

- 混合调用中立即把 `code_search/CodeSearch/SmartReading` 原生工具帧交给 Devin。
- 本地 Grep 同步执行并继续显示紧凑结果，不占用 Devin 的工作区索引执行器。
- Fast Context 已交付后不再同时开启上游 continuation，避免两个执行序列争用同一 Cascade 响应流。
- 本地 Grep 的结构化调用与结果按 Cascade 暂存；Devin 返回 Fast Context 工具结果后的下一轮，再把本地轨迹恢复到原生调用之前。
- 不生成 `LSP tool ... not executed in proxy retry` 占位结果。
- Fast Context 仍完全使用 Devin 原生 LSP、原生工作区索引和原生语义搜索，没有本地替代实现。

## 回归验证

- 核心路由闭环测试。
- 工作区工具策略及真实 Responses 流测试。
- 同一 Responses 输出内 `grep_search + code_search` 混合调用测试。
- Fast Context 原始调用帧立即可见测试。
- 原生 Fast Context 工具结果回传及跨轮顺序测试。
- 无代理占位结果测试。

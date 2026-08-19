# dao-proxy-pro 9.9.405

## Grep 结果展示优化

9.9.404 已经让本地 Grep 结果在 Devin 会话中可见，但普通换行会被 Markdown 渲染器折叠为空格。结果较多时，所有路径与源码会连成一个很长的段落，而且每条命中重复完整绝对路径。

9.9.405 改为：

- 第一行显示查询、命中数量和文件数量。
- 搜索根目录只显示一次。
- 匹配内容放入保留换行的 `text` 代码块。
- 按文件分组，每个文件路径只显示一次。
- 文件路径相对于搜索根目录显示。
- 每条匹配使用 `行号 | 源码` 格式。
- 仍最多显示前 48 KiB，完整结构化结果继续提供给模型。

示例：

````text
**grep_search** `EnglishCompositionSpecialization` · 4 条匹配 · 2 个文件

范围：`E:\项目\Assets\Scripts`

```text
HotUpdate\UI\Panel\Home\HomeUI.cs
  359 | EnglishCompositionSpecializationUI.Open(...)

HotUpdate\Core\Game\UIControllerHelper.cs
  224 | UIPageType.EE_EnglishCompositionSpecialization,
  225 | "Assets/Library/UIPrefab/..."
```
````

## 验证

- 核心全链路：`347/347`。
- 工作区策略：`32 + 15 + 25 + 8`。
- Markdown 摘要与布局保持代码块：通过。
- 跨轮 Grep 轨迹、Fast Context 原生执行与空流恢复：通过。

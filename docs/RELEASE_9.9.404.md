# dao-proxy-pro 9.9.404

## 根因

9.9.403 已能在同一次 Responses continuation 中执行本地 Grep 并继续调用 Fast Context，但插件为了避免 Devin 再执行会失败的 Grep，没有把该内部工具调用写入 Devin 的会话轨迹。

因此出现了两种表象：

- 会话窗口看不到 `grep_search` 的真实结果。
- 下一次 `code_search/read_file` 返回后，Devin 重新提交的历史中没有 Grep 调用和结果，上游模型又判断“第 2 步尚未产生工具返回”，重复调用 Grep。

日志中实际 Grep 均已执行，记录为 `serverSide=1 names=grep_search`；问题是跨轮历史缺口，而不是搜索路径或执行器再次失败。

## 修复

### 跨轮结构化轨迹

插件按稳定 `cascadeId` 保存本地 Grep 的 assistant function call 与真实 tool result。后续 Devin 请求缺少这段内部轨迹时，插件会在对应的原生 `code_search/read_file` 调用之前恢复它，使上游输入与上一轮 Responses continuation 保持相同顺序。

- 不要求 Devin 执行本地 Grep。
- 不改写或代理 `code_search/Fast Context`。
- 不替换 `find_by_name/read_file/list_dir` 的原生执行器。
- 轨迹按会话隔离，TTL 为两小时，并设置会话与记录数量上限。
- 恢复位置使用后续原生工具 call id 锚定，避免把 Grep 结果错误追加到最新工具结果之后。

### 会话内可见结果

本地 Grep 完成后，Devin 当前回复会显示：

- 搜索范围。
- 命中数量。
- 文件路径与行号。
- 命中的源码片段。
- 是否因扫描时限而截断。

界面最多显示前 48 KiB，避免大量命中挤压会话；完整结构化结果仍提供给模型。

## 验证

- 核心全链路：`347/347`。
- 工作区策略：`32` 项。
- 原有工作区集成：`15` 项。
- Responses Grep 可见结果与跨外部轮次轨迹：`23` 项。
- 空 Responses 自动恢复与显式失败：`8` 项。
- 本地工具、ACP 工作区/stdio、工具策略、上下文、缓存、项目提示词与 Webview：全部通过。

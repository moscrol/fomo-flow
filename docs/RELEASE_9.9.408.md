# dao-proxy-pro 9.9.408

## Fast Context Windows URI 修复

本版修复 Devin 原生 `code_search / Fast Context` 在 Windows 工作区偶发直接显示 `Skipped` 的问题。

实机日志确认调用已由插件作为原生 LSP 工具交回 Devin，但 `instant_context_agent` 随后报告：

```text
Error parsing tool call arguments: invalid character 'R' in string escape code
```

`code_search` 的路径参数名为 `search_folder_absolute_uri`。旧逻辑只在相对路径解析时生成 file URI；如果模型已经给出 `E:\项目\...` 形式的绝对路径，则原样透传。Devin 的 Fast Context 子代理在生成嵌套工具 JSON 时可能把 `\R` 等路径片段当作非法 JSON 转义，从而在真正搜索前退出。

9.9.408 对 URI 路径字段统一发送标准形式：

```text
file:///E:/项目/...
```

边界保持不变：

- Fast Context 的索引、语义检索和结果生成仍由 Devin 原生 LSP/Cortex 执行。
- 插件不实现本地 Fast Context 替代品。
- `grep_search` 的本地兜底不变。
- `find_by_name`、`read_file`、编辑与终端工具不受影响。
- Unity/SVN 项目的 `.codeiumignore` 排除生成目录和版本库元数据，候选文件量保持在原生 5,000 文件上限以内。

## 验证

- 绝对路径到 file URI 的单元回归通过。
- 工作区路径修复、Grep 兜底与原生 Fast Context 分流回归通过。
- 核心路由、ACP 工作区消息和 stdio 代理回归通过。

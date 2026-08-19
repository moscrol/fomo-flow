# dao-proxy-pro 9.9.409

## Fast Context Windows 原生绝对路径修复

9.9.408 将 `search_folder_absolute_uri` 转换为 `file:///E:/...`。实机结果证明当前 Devin Windows 执行器虽然使用了 `uri` 字段名，实际仍按原生文件系统路径校验，file URI 会被判定为“非绝对路径”。

9.9.409 改为发送：

```text
E:/新增运行时状态机
```

该格式同时满足两个条件：

- 对 Windows 和 Devin 执行器仍是绝对路径。
- 不含反斜杠，不会在 Fast Context 内部嵌套工具 JSON 中产生 `\R` 一类非法转义。

`grep_search`、`find_by_name`、`read_file` 以及编辑、终端工具不受影响。Fast Context 的索引与执行仍由 Devin 原生 LSP/Cortex 负责。

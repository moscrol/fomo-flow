# Dao Flow Work Item 产物审阅设计

- 状态：进入 P1 执行
- 目标：让当前工作桌对任务的安全产物、尝试终态和终端摘要给出小白可读的审阅入口。

## 边界

- 只使用既有 `/origin/tasks` 的安全投影；不新增 endpoint、IPC、远程服务或 shell 执行能力。
- 只展示已经归一化的 `status`、`exitCode`、`errorCategory`、`stdoutSummary`、`stderrSummary` 与 artifact `ref/kind`。
- 不渲染 job/session ID、原始命令、prompt、Authorization、凭据或完整路径。
- 产物只提供“查看详情/复制交接”语义，不自动打开文件、不自动运行命令、不修改任务。

## 验收

1. 失败、完成、无产物三种状态都有直白中文说明。
2. 产物数量与有限引用可见，敏感字段不进入 DOM。
3. 任务接口失败仍保留当前工作桌安全数据并显示可恢复提示。
4. focused + 全量测试、typecheck、lint、build、Electron bundle 与 root smoke 通过。

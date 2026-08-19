# Dao Flow 最近请求历史设计

## 问题

运行时同时维护累计 usage 和有界的安全请求样本。当前 `usage()` 仅把 `input > 0` 的样本作为 `requests` 返回，因此上游失败、超时或尚未获得 usage 的真实请求会从请求历史消失；累计调用和告警仍增长，HUD 却显示“等待首个缓存观测样本”。此外 extension/runtime 自然重启会清空内存样本，让 HUD 在刚刚有真实请求后又回到空表。

## 设计

按 provider 保留三种有界状态：

1. `requests` 返回最近的安全请求样本，不以 token 数作为准入条件，因此零 token 的失败也可出现在请求时间线。
2. 安全请求样本会以原子 `0600` 文件保留在配置目录，最多 50 条、最多 24 小时；重启时只恢复该安全投影，不恢复 prompt、Authorization、完整路径或原始请求 ID。
3. `recent` 缓存窗口继续只使用当前进程中 `input > 0` 样本，确保命中率只由本次可计算的 token usage 决定。

样本仍受既有 50 条全局、20 条每 provider 的内存上限和字段脱敏约束；不记录 prompt、Authorization、完整路径或原始请求 ID。既有 HUD 直接消费 `requests`，无需新增 endpoint 或 Electron IPC。

## 验收

- 一个 input 为 0、带失败类别的请求会出现在 `usage().provider.requests`。
- 它不会增加 `recent.calls` 或改变 `recent.hitRate`。
- Web HUD 和桌面“最近请求”能投影该安全样本。
- 重启后的 `usage()` 会保留最近 24 小时的安全请求行，但 `recent` 缓存窗口保持本次进程的真实样本。
- 真实运行时的 `/origin/ea/usage` 不再在累计调用存在、仅零 token 样本存在时返回空 requests。

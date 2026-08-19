# Dao ACP 协作工作台设计

## 目标

把 Dao Electron 定位落实为 ACP 协作控制平面的第一批原生界面：

1. `任务中心`展示跨 Codex、Devin 与 ACP 客户端的任务生命周期、尝试、回退和产物。
2. `ACP 协作`展示会话谱系、活动状态、当前路由、缓存/延迟事实和安全交接信息。

## 非目标

- 不复制 cc-haha 的聊天、终端、浏览器、工作树或宠物功能。
- 不在本切片新增任务调度、取消、模型修改或文件写入操作。
- 不让 Electron renderer 直接访问文件系统或 ACP 子进程。

## 方案

Electron renderer 通过既有 `desktopHost.requestControl` 访问 loopback runtime。`/origin/hud/snapshot` 提供会话、实时任务、路由和观测投影；`GET /origin/tasks` 提供任务的完整安全摘要（最多八次公开尝试和有限产物引用）。由于 runtime 的任务接口可能启用本地 bearer key，Electron 主进程只在任务读取时从同源 `/origin/revproxy/status` 取得 key 并注入请求头，key 不进入 renderer。Electron 控制面白名单只增加这两个只读访问路径的任务权限；写操作保持拒绝。

前端新增一个独立的归一化模型模块，负责裁剪字符串、时间、状态和未知数据。`AcpWorkbenchView` 使用会话列表 + 选中会话详情 + 活动/请求流；`TaskCenterView` 使用指标条 + 状态筛选 + 任务列表 + 选中任务的尝试/产物详情。两个页面共享控制面视觉原语，但不共享业务状态。

## 数据契约

### CollaborationSession

```text
id, surface, lifecycle, active, warning, goal, phase, workspace,
route(provider, modelUid, upstreamModel, provisional),
telemetry(ttftMs, durationMs, modelPath, loopSource),
cache(observed, calls, cached, hitRate), latestActivityAt
```

### CollaborationTask

```text
jobId, source, taskType, workspace, targetWorkspace, commandSummary,
status, phase, progress, createdAt, updatedAt, lastHeartbeatAt,
recoveryReason, result(status, exitCode, errorCategory, summaries, artifacts),
attempts(provider, model, fallbackUsed, fallbackReason, toolCallCount,
durationMs, errorCategory, at)
```

所有字段都从服务端安全投影读取；界面不显示 prompt、密钥、完整路径、原始会话 ID 或工具参数。

## 交互

- 左侧导航增加 `协作` 与 `任务`，命令面板可搜索。
- 协作页每 3 秒刷新，默认选中最近活跃会话；可按 ACP/Codex/Devin 筛选。
- 任务页每 3 秒刷新，默认显示全部任务；状态筛选不改变服务端数据。
- 选中任务后展开尝试时间线和产物引用；对失联/回退/失败使用明确色阶。
- runtime 不可用或接口失败时显示可恢复的错误状态，不伪造空的成功数据。

## 安全与兼容

- 继续走 loopback + Electron IPC 白名单；不开放任意路径代理。
- 仅增加 `GET /origin/tasks` 和已有 HUD snapshot 的读取权限。
- 老版本 HUD 数据缺字段时归一化为“未知/暂无”，页面仍可渲染。
- 组件完全使用 Dao 自己的 React/TypeScript 数据模型；cc-haha 只作为信息架构参考。

## 验收

1. `npm run typecheck`、`npm run lint` 和桌面 Vitest 全部通过。
2. runtime 可用时，协作页能显示真实会话/路由/缓存事实；无会话时显示空态。
3. 任务页能读取 `/origin/tasks`，展示至少一条任务的状态、尝试数和结果；无任务时显示空态。
4. 控制面测试确认任务 GET 被允许，任务 POST/任意外部 URL 仍被拒绝。
5. Desktop runtime smoke 能以本地 key 读取 `/origin/tasks`；未经 key 的直连仍返回 401。
6. 打包后的 Electron 页面不依赖浏览器跨域或 nodeIntegration。

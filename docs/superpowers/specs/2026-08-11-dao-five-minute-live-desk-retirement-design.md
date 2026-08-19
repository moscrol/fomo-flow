# Dao Flow 五分钟实时桌退役设计

## 目标

`当前工作` 只展示最近仍有可信事实的会话和任务。无论项目状态是运行中、失败、超时、断连还是需要人工处理，只要最后可信活动/更新已经超过五分钟，就从实时桌退出；源数据和历史视图不删除。

## 方案

在 `workLifecycleProjection` 的领域投影层统一执行新鲜度判断，而不是在 UI 里过滤。会话使用 `latestActivityAt`，任务使用 `updatedAt`、`lastHeartbeatAt` 与 `result.finishedAt` 的最大值。事实时间超过五分钟时直接返回 `closed`，只有未过期事实才继续进入 running/attention 分类。恰好五分钟仍属于实时窗口，超过五分钟才退役。

这保留了“需要我处理”对新鲜失败的可见性，同时避免旧失败无限占用当前工作。Taskboard 的计划事项、协作会话历史和任务历史继续独立保留；本次不新增写接口、不改变路由 priority、不停止 IDE 或远程进程。

## 验收

- 新鲜的 blocked/warning session 仍显示为“需要我处理”。
- 超过五分钟的 blocked/warning session 返回 `closed`。
- 新鲜的 failed/timed_out/detached/transport_lost task 仍显示为“需要我处理”。
- 每一种上述 task 超过五分钟均返回 `closed`，且使用统一退役原因。
- 当前工作 UI 不再显示这些过期项，历史/Taskboard 数据仍可访问。
- 既有实时运行项、导航、路由选择和安全字段投影保持不变。

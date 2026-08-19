# Dao Flow 显式干预与交接设计

- 日期：2026-08-10
- 状态：沿用已批准的 Agent 控制桌路线图，进入 P1 执行

## 目标

让「当前工作」里的每个 Work Item 都能清楚地告诉用户“我现在能做什么”，并提供可逆、需确认的交接动作。P1 只接入已经存在的安全投影和桌面能力；它不伪造 Agent 执行能力，不自动暂停/重试/取消任务，也不自动改变模型渠道优先级。

## 用户可见动作

1. **查看路由建议**：在当前工作条目详情中展示现有 observability advisory 的 profile、候选渠道、评分和理由。文案明确“仅供比较，不会自动切换”。
2. **准备下一次优先级草稿**：用户可以在本地临时选择一个候选顺序作为草稿；草稿只存在 React 内存中，离开视图即丢失。只有已有的显式保存入口、且用户二次确认后，才允许调用现有配置写入路径；P1 默认不提供自动保存。
3. **复制/保存交接包**：调用现有 `/origin/ea/handoff.md` GET，随后使用 `desktopHost.writeClipboard` 或 `desktopHost.saveHandoff`。交接包继续由 runtime 安全摘要生成，不把 prompt、Authorization、原始 session/job ID 或完整路径写进 UI。
4. **打开关联入口**：通过既有 `onOpenItem` 导航到协作会话或任务详情；不拼接外部 URL，不执行 shell。

## 数据与边界

- advisory 读取只用现有 `GET /origin/ea/routing-decisions?profile=<profile>&limit=20`；不引入自动 scorer 重排、路由 dispatch 或新的 IPC allowlist。
- Work Item 的 `target.id` 仅作为内存 drill-in token，不能进入 DOM 文本、属性、日志或 handoff。
- 未经底层明确授权的 pause/retry/cancel 按钮不显示；若 runtime 未来暴露安全能力，另开设计和验收。
- 所有写动作都必须有清晰的“保存/复制/另存”标签、busy 状态和错误提示；读取失败不清空当前安全数据。

## 组件边界

- `CurrentWorkControlView` 继续负责聚合、轮询和导航，只增加选中 Work Item 的内存状态。
- 新增 `WorkItemInterventionPanel` 负责动作状态、交接包和“仅供比较”说明；它接收已归一化的安全数据和回调，不读取 raw payload。
- `ObservabilityControlView` 的已有 advisory 逻辑保持不变；P1 不复用其自动 profile 切换或保存流程。
- 现有 `CollaborationHandoffActions` 继续作为复制/保存实现，不重复造文件系统或剪贴板逻辑。

## 验收

1. Work Item 详情显示路由 advisory 的“仅供比较，不会自动切换”说明；切换比较 profile 不发配置写请求。
2. 复制和另存交接包只调用一个 GET 加一个现有桌面动作；测试断言不会出现 POST/PUT/DELETE。
3. 没有底层授权时不出现 pause/retry/cancel；priority 草稿不落 localStorage，不改变真实配置。
4. 失败、取消保存和重复点击都有可读状态；既有 Work Item、App drill-in、全量 desktop 测试不回归。
5. 根 smoke、lint、typecheck、production build 和 Electron bundle 通过；taskboard 交接记录变更、测试和当前运行时限制。

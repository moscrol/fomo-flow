# Dao Flow 控制桌质检修复设计

- 日期：2026-08-10
- 状态：根据独立质检结果进入修复

## 目标

修复控制桌中被质检发现的集成可达性、干预契约、隐私脱敏、并行刷新、空态导航和视觉 token 问题，同时保持本地优先、GET-only、无 shell、无自动 priority 变化。

## 设计

1. 当前工作条目的点击只在当前工作页选中并展开详情；详情区提供单独的“打开协作会话/打开任务进度”按钮，调用既有 `onOpenItem`。
2. Work Item 增加内存安全字段 `profile`（来自已归一化的 advisory profile，缺省为 `balanced`），不把 provider/model 展示串伪装成 profile。干预面板接收安全投影和动作回调；候选顺序草稿只在 React 内存中维护，不写 localStorage 或配置 API。
3. CurrentWork 使用 `Promise.all` 并行读取 HUD/tasks，并保留现有 refresh sequence guard、任务降级和安全数据保留行为。
4. 抽出共享 `sanitizeDisplayText`，覆盖 Bearer、sk、任意 Authorization scheme、Unix 常见绝对路径与 Windows 路径；模型和产物投影统一调用。
5. 空态提供“查看实时情况”和“配置接入渠道”按钮；新增 CSS token 使用现有变量并带 fallback，确保主题下可见。

## 验收边界

- 不新增 endpoint、IPC、远程服务、shell 执行或外部 URL。
- 不自动保存 priority；只验证内存草稿和离开视图即丢失。
- App 集成测试必须证明点击条目后当前工作详情仍可见，只有点击详情动作才导航。
- 全量 desktop tests、lint、typecheck、build、Electron bundle 和 root smoke 必须通过。

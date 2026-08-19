# Buzz-inspired Dao ACP 安全交接包设计

## 背景

Buzz 将聊天室、agent session 和运行事件作为可携带协作上下文。Dao 已经有会话、
任务与语义活动的安全投影，也已有 Electron clipboard 和“另存 handoff” IPC。当前
缺少的是把这些事实组织成一个可交给下一个人或 agent 的简短包。

## 目标

1. 为选中的 ACP 会话生成 Markdown 交接包。
2. 为选中的任务生成 Markdown 交接包。
3. 支持一键复制与“另存为 `.md`”，复用既有主进程 IPC 边界。
4. 交接包仅基于安全 projection；重复遮罩敏感文本，避免把 raw rail 带出。

## 非目标

- 不新建聊天室、agent memory、远程 relay 或后台同步。
- 不让交接操作控制、取消或重试任务。
- 不读取 renderer 以外的文件、环境变量、完整路径、prompt 或原始事件。

## 数据与格式

### 会话包

包含目标、surface、当前生命周期、路由、阶段、结构化待办、缓存/延迟事实与最多六
条最近语义事件。事件只保留 `动作 · 对象 → 结果` 和安全摘要；不含 event/session/turn
ID 或 raw JSON。

### 任务包

包含来源、任务类型、状态、工作区 basename、阶段、进度、心跳、恢复原因、最多五次
尝试、终态摘要与最多二十个产物引用。任务 ID、原始命令、完整 stdout/stderr 与路径
不出现在包中。

两种包都包含一个“接手建议”区：会话取当前待办，任务取非终态阶段/进度；终态任务
明确标为“可审阅交接产物”。这是提示而不是执行命令。

## 组件边界

- `collaborationHandoff.ts`：纯 Markdown 组装与二次脱敏；不依赖 React 或 Electron。
- `CollaborationHandoffActions.tsx`：接收内容与文件名，处理复制/另存和用户可见结果。
- ACP 与任务页面只负责调用 builder 并将结果传给 actions，不持有额外状态。

## 安全与失败行为

- 文本二次处理 Bearer、`sk-`、Unix/macOS/Windows 完整路径；正文上限受已有模型限制。
- 主进程保存取消时显示“已取消保存”，clipboard/save 失败显示操作失败，不假报成功。
- 生成完全本地且只读；不需要 Dao runtime 新增端点。

## 验收

1. 纯函数测试验证会话/任务字段、限制、脱敏和 ID 排除。
2. UI 测试验证 copy/save 调用既有 `desktopHost`，以及成功/取消提示。
3. ACP 和任务页面均可见交接操作。
4. `npm --prefix desktop run typecheck`、`lint`、`test`、`build` 通过。

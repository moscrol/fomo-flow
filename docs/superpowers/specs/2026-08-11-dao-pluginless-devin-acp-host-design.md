# Dao Flow 无插件 Devin ACP Host 设计

## 1. 目标

Dao Flow 在 Electron App 内直接启动和管理新的 Devin ACP 会话，使用户不安装 Dao Flow Devin 插件，也能让 Devin 的模型请求经过 Dao Flow，并在 App 中看到会话进度、工具调用、权限请求和安全结果摘要。

这一能力把 Dao Flow 从“只观察外部 ACP 会话”补成“既能观察，也能作为本地 ACP Host 发起会话”的协作桌。它不会尝试接管已经在 Devin 原生界面中创建的会话。

## 2. 明确边界

### 本期包含

- macOS 上检测已安装的 Devin ACP 可执行文件。
- 在主进程中启动 `dao-acp-stdio-proxy.js → devin acp`。
- 通过 ACP v1 建立连接、创建一个受控会话、发送用户明确提交的任务、接收流式更新。
- 展示文本回复、阶段进度、工具调用状态和权限请求。
- 用户显式允许或拒绝权限请求；默认不允许。
- 用户显式取消当前任务或停止会话。
- 选择本地工作目录；完整路径只保存在 Electron 主进程，展示层只收到目录名和不可逆本地句柄。
- 从 ACP 返回的模型配置选项中展示可选 Dao 模型；用户选择只作用于新会话，不写全局 priority。
- 将受控会话的安全状态投影给现有“当前工作”和“协作会话”观测面。

### 本期不包含

- 不修改、安装、卸载或读取 `~/.devin/extensions` 中的 Dao Flow 插件。
- 不劫持 Devin 原生聊天、系统代理、TLS 证书或 Devin 私有接口。
- 不构建文件编辑器、终端模拟器、Diff 编辑器或完整 IDE。
- 不自动批准工具权限，不自动选择 provider/model，不保存路由 priority。
- 不持久化 prompt、Authorization、完整路径、ACP 原始 session ID 或原始协议帧。
- 不增加远程控制入口；ACP Host 只在本机 Electron 主进程运行。

## 3. 用户体验

在“协作与交接”新增一级入口“Devin 接入”。页面按结论优先展示：

1. **接入状态**：Dao Runtime 是否可用、Devin ACP 是否找到、当前会话是否已连接。
2. **连接 Devin**：选择工作目录并点击“创建本地会话”；握手成功后才展示该会话实际返回的模型选项。
3. **发送任务**：选择当前会话模型（或沿用现有优先级）、输入任务并显式发送。
4. **正在进行**：按时间顺序展示 Devin 文本、进度、工具调用和权限卡片。
5. **会话操作**：任务运行时可取消；会话可显式停止。停止后不可继续发送。

页面初始不自动启动 Devin。目录选择、会话创建、任务发送、权限回答、取消和停止都是可理解的显式按钮。任务输入只保留在当前 React 状态；发送成功后可以清空输入框。

同一 App 实例本期只管理一个受控 Devin ACP 会话。这样可以避免多进程权限归属、交错输出和资源泄漏，同时已经覆盖“无插件发起 Devin 工作”的主要目标。

## 4. 架构

### 4.1 主进程：`DevinAcpHostService`

新增独立服务，负责：

- 检测固定白名单中的 Devin 可执行文件：
  `/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin`。
- 从打包资源解析 Dao ACP stdio proxy，而不是接受 renderer 传入命令或路径。
- 使用 `child_process.spawn(process.execPath, [proxyPath, devinPath, 'acp'])` 启动子进程，并设置 Electron 子进程所需的 Node 执行环境。
- 通过官方 `@agentclientprotocol/sdk` v1 的 Client 连接 stdio 流。
- 保存真实 workspace 路径、ACP session ID、权限请求 ID 和子进程对象。
- 把原始 ACP 更新投影成有限、安全、可序列化的 renderer 事件。
- 在停止、进程退出和 App `before-quit` 时清理连接与子进程，使用有限超时后强制终止，避免僵尸进程。

服务只暴露窄接口：`status`、`chooseWorkspace`、`start`、`prompt`、`respondPermission`、`cancel`、`stop`、`subscribe`。Electron 主入口只负责装配，不解析 ACP 业务。

### 4.2 ACP Client 适配器

SDK 接入封装在适配器中，避免 Electron 生命周期、协议细节和 UI 状态耦合。适配器负责：

- `initialize` 能力协商。
- `session/new` 创建会话。
- 从新会话返回的 `configOptions` 读取模型选项。
- 仅在用户选择模型后调用 `session/set_config_option`；不选择时保留 Devin/Dao 现有默认值。
- `session/prompt`、`session/cancel`。
- `session/update` 的文本、进度、工具调用和权限请求转换。

若 Devin 或 SDK 协议版本不兼容，适配器返回稳定的错误码和小白可读文案，不把 raw JSON-RPC 错误或栈暴露给 renderer。

### 4.3 Renderer 安全模型

新增 `devinAcpHost` 类型模块，定义状态机：

- `unavailable`：未找到 Devin。
- `runtime_offline`：Dao Runtime 未就绪。
- `ready`：可以创建会话。
- `starting`：正在握手。
- `connected`：已创建会话，可以发送任务。
- `running`：任务执行中。
- `waiting_permission`：等待用户明确决策。
- `stopping`：正在清理。
- `stopped` / `failed`：终态。

展示事件只允许：bounded 文本、阶段标签、工具类别、时间、状态和 renderer 本地事件 ID。所有文本复用现有 `sanitizeDisplayText`，并额外限制单条和总条数。原始 session ID、permission request ID、命令参数、环境变量和完整路径留在主进程映射表。

### 4.4 IPC

新增精确 IPC channel：

- `dao:devin-host-status`
- `dao:devin-host-choose-workspace`
- `dao:devin-host-start`
- `dao:devin-host-prompt`
- `dao:devin-host-permission`
- `dao:devin-host-cancel`
- `dao:devin-host-stop`
- 主进程到 renderer 的 `dao:devin-host-event`

所有 renderer → main payload 采用严格键集合、类型、长度和枚举校验。renderer 不能提供可执行文件路径、proxy 路径、任意命令、任意环境变量、ACP session ID 或本地绝对路径。

`choose-workspace` 无 payload，由主进程打开原生目录选择器并返回 `{ handle, label }`。`start` 只接受该次 App 生命周期内由主进程签发的 workspace handle。prompt 最大 64 KiB，只在 IPC 调用期间传递，不写入日志或磁盘。

## 5. 路由语义

模型选择沿用现有 `dao-acp-stdio-proxy.js` 暴露的 Dao 模型配置能力。页面只显示 ACP 新会话返回的合法选项，不自行猜测或从 route 展示串拼装模型值。

- 未选择：使用当前既定默认和 priority。
- 用户为当前新会话选择一个模型：调用 ACP `session/set_config_option`，只改变这个 ACP 会话。
- 绝不调用 Dao route priority 写接口。
- 绝不根据延迟、缓存命中率或建议自动切换。

若配置选项不可用，页面隐藏模型选择器并显示“此 Devin 版本暂不支持会话内选择，将沿用现有路由优先级”。

## 6. 权限与安全

- 权限请求进入主进程的 pending map，以 renderer 本地随机 ID 代替 ACP 原始 ID。
- renderer 只看到动作类别、脱敏说明和“允许一次 / 拒绝”选项。
- 本期不提供“始终允许”。未回答、窗口关闭、会话停止或超时均视为拒绝。
- 只响应仍 pending 且属于当前受控会话的请求；重复或过期响应被拒绝。
- 工具输入、shell 命令和完整文件路径不进入 renderer。必要说明投影为“读取文件”“修改文件”“运行本地命令”等类别。
- 主进程日志只记录状态码和安全错误类别，不记录 prompt、ACP payload、Authorization 或工作目录。

## 7. 生命周期与现有观测的关系

受控会话通过安全投影进入现有 HUD/当前工作数据源，来源标记为 `devin-host`，并使用不可逆 fingerprint。它遵守当前工作桌“超过五分钟无活动即从实时列表退役”的展示规则。

五分钟退役只影响实时观测列表，不暗中终止 Devin 子进程。进程只在用户点击停止、ACP/子进程退出或 App 退出时结束，避免把“看板退役”错误地变成“杀任务”。

## 8. 错误处理

- **Devin 未安装或路径不匹配**：显示安装/更新提示，不回退到插件，不扫描用户目录。
- **Dao Runtime 离线**：阻止启动，提供“重试 Dao Runtime”。
- **握手或鉴权失败**：安全结束子进程，显示可重试结论；不无限重启。
- **子进程异常退出**：会话转为 `failed`，保留有限安全事件供用户判断。
- **事件过多**：保留最近 200 条，较早事件只累加被折叠计数。
- **renderer 重载**：主进程会话继续存在；新 renderer 通过 `status` 获取当前安全快照并重新订阅。
- **App 退出**：先拒绝 pending 权限，再取消会话、终止子进程，最后停止 Dao Runtime。

## 9. 打包

Electron 打包资源需要包含：

- `dao-acp-stdio-proxy.js`
- proxy 的本地 CommonJS 依赖：`acp-session-bridge.js`、`acp-session-lineage.js`、`acp-workspace-message.js`、`core/dao_local_endpoint.js`
- ACP SDK 的运行时依赖（由 Electron main bundle 或显式资源携带，构建测试验证）。

打包后的服务只从 `process.resourcesPath` 解析这些资源。开发环境从仓库根解析，并通过同一 resolver 测试，避免开发可用、安装包缺文件。

## 10. 测试与验收

### 自动测试

- fake ACP child 覆盖 initialize、新会话、config option、流式文本、工具状态、权限、取消和退出。
- 主进程服务测试状态机、单会话限制、renderer 重载快照、退出清理和不会自动重启。
- IPC capability 测试拒绝任意命令、路径、环境变量、超长 prompt、未知 permission ID 和相似 channel/payload。
- 安全投影测试确保 prompt 回显、Authorization、完整路径、命令、原始 session/request ID 不进入快照和事件。
- React 测试覆盖空态、状态结论、目录选择、模型选项、手动权限、取消/停止、错误与无障碍焦点。
- 路由守卫测试确保没有 priority 写调用、没有自动模型选择。
- 打包 smoke test 断言安装资源完整且 proxy 可以启动 fake ACP child。

### 实机验收

1. 构建并安装 `/Applications/Dao Flow.app`。
2. 在不依赖 Dao Flow Devin 插件的路径下验证 App 能检测本机 Devin ACP。
3. 验证 Dao Runtime 健康、目录选择和 ACP 握手成功；不发送用户真实 prompt，不批准真实工具操作。
4. 验证页面只显示目录名、安全状态和合法模型选项。
5. 验证停止测试会话后无遗留 Devin ACP/proxy 子进程。
6. 验证原 Devin 插件目录内容和进程启动配置未发生改动。

## 11. 完成标准

- 用户可以只从 Dao Flow App 创建一个新的 Devin ACP 会话并显式发送任务。
- 该会话的模型请求经过 Dao ACP proxy 和现有 Dao Runtime。
- App 可读地展示回复、进度、工具状态和权限请求。
- 所有危险动作由用户显式触发，路由 priority 保持不变。
- App、renderer 和持久化数据不包含禁止的敏感字段。
- 自动测试、Desktop 全量测试、typecheck、lint、build、macOS 打包和实机 smoke 均通过。
- Devin 插件未被修改；Devin 原生既有会话行为保持不变。

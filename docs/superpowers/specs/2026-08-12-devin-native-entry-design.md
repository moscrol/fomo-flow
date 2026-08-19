# Devin 原生入口与 App 边界设计

## 目标

让 `Devin 接入` 默认打开本机 Devin 原生窗口并进入所选工作目录。Dao Flow 继续作为本地 API、路由、缓存和会话观测桌；内置 ACP 客户端保留为明确的高级托管模式。

## 产品边界

- 默认入口只由 Electron 主进程调用固定 Devin CLI：`/Applications/Devin.app/Contents/Resources/app/bin/devin-desktop --new-window --agents <workspace>`。
- Dao Flow App 不安装、卸载、改写、启用、禁用或诊断 Devin 插件。Devin 自己管理其设置、扩展和既有窗口。
- App 可以只读消费本机运行时与 `agent-status` 的安全投影，用于展示会话、渠道和模型；这不构成插件管理。
- 工作目录只由主进程从内存句柄解析；renderer 不能传入路径、URL、可执行文件或额外参数。
- 不向 Devin 原生窗口注入 prompt、Authorization、模型密钥或任意用户命令。
- 高级托管模式继续使用固定 Devin ACP 资源和逐次权限确认，两种模式在 UI 上分开标识。
- 默认与高级入口都不修改 provider、model、protocol 或 route priority。

## 数据流

1. 用户选择工作目录。
2. 默认按钮调用 `openDevinNative(workspaceHandle)`。
3. Electron 主进程从内存句柄解析路径，通过固定 CLI 打开 Devin Agents 窗口。
4. Dao Flow 返回“已打开 Devin”的状态，并继续读取可用的本机安全观测事实。
5. 用户显式选择高级模式时，才调用 `startDevinHost(workspaceHandle)` 并显示托管 ACP 的事件、任务输入和权限卡。

## 失败处理与安全

- Devin App 不存在或工作目录句柄失效时返回稳定的用户可读错误。
- IPC 只接受 32 位十六进制句柄，不接受路径、命令、扩展 ID 或 URL。
- UI 不渲染完整路径、原始 session/job ID、prompt 或 Authorization。
- 发布包排除运行态请求历史、决策收件箱、诊断 dump、用户配置和备份文件。
- 交付只包含显式核对过的 App 源码、测试和文档，不覆盖无关脏改动。

## 验收

- 启动器单测验证参数严格为 `--new-window --agents <main-only workspace>`，没有扩展管理参数。
- React 测试验证默认按钮不会调用 `startDevinHost`，高级按钮仍明确走托管 ACP。
- 源码扫描确认 Desktop 没有插件安装、卸载、启停或写入路径。
- 打包扫描确认 `.dao-request-history.json`、`route-decision-inbox.json`、诊断 dump、配置和备份不进入 App。
- 全量测试、typecheck、lint、arm64 打包和 `/Applications/Dao Flow.app` 安装验收通过。

## 当前状态

本规格取代此前的“窗口级插件运行态隔离”方案。Devin 插件生命周期不属于 Dao Flow App 交付范围。

# FOMO FLOW Desktop

FOMO FLOW Desktop is the macOS Apple Silicon application for the local model gateway and ACP collaboration control plane. It starts the routing runtime itself and presents sessions, tasks, routing and observability as a React/Bun desktop workspace; VS Code, Devin, and a previously running gateway process are not required.

## Development

From this directory:

```bash
npm install
npm run dev
npm run typecheck
npm run test
npm run build
```

`npm run dev` starts the Electron host and the local FOMO FLOW runtime. Bun is project-local build tooling; the packaged runtime remains the Node/CommonJS gateway service.

The default React workspace loads one native capability component at a time. The sidebar is intentionally reduced to four plain-language desks:

- `当前工作`：只看现在仍在运行、需要处理或等待验收的工作。
- `流量观测`：看最近请求、缓存/会话亲和、运行健康、路由证据与问题记录。
- `ACP 协作`：看 Agent 名册、会话、协作链、未关联任务和产物，并显式添加 Agent 或打开任务详情。
- `设置`：管理渠道、路由、自定义模型、IDE 接入与低频高级连接。

原有 17 个原生视图都保留。侧栏只显示四个一级入口；进入子视图时仍高亮所属一级桌面，`设置` 和 `⌘K` 命令面板可以到达所有旧能力。导航收口不会删除组件、改变运行时行为或新增远程能力。

`当前工作` 是默认实时桌面：每三秒并行聚合来自同一个已选真实本机观测源的 HUD 摘要与任务数据，只展示“需要我处理 / 正在进行 / 计划与验收”。顶部观测条会直白显示本机数据源端口、读到的会话/长任务数量和已经退出实时桌的数量，因此空桌面也能区分“观测正常但没有运行工作”与“数据源不可用”。终态或超过 5 分钟没有可信活动的会话，以及成功、取消任务，会退出桌面，但完整记录继续保留在 `协作会话` 和 `任务进度`；仍在时限内的验证阻塞及失败、超时、连接中断任务保留到用户点击 `我知道了` 或显式加入 Taskboard。`我知道了` 只写入带时限、上限和原子替换保护的 SHA-256 本地处理账本，不保存原始 session/job ID。点击条目先在当前工作页展开安全详情、干预和任务产物，只有再次点击明确的“打开协作会话 / 打开任务进度”按钮才进入对应历史视图；空桌面提供前往实时情况和接入渠道的入口。

当前工作脉冲借鉴 Claude HUD 的“现在在做什么”体验，但只使用本机已有的安全 Todo、登记进度、验证/任务结果和最近活动时间；它不读取 IDE transcript、工具参数或 prompt，也不会改变路由或 Taskboard 状态。

当前工作现在还把会话、最近请求、长任务、Taskboard 和待确认事项统一投影成一条本地安全语义活动流，用“谁做了什么 → 结果怎样”直接展示。选中工作后打开的本地“工作舱”只聚合能够用不透明 owner key 可靠关联的进度、路由尝试、产物、干预建议与交接入口；没有明确 owner key 的请求继续留在全局活动流，FOMO FLOW 不会根据 surface、provider、model、时间或工作区猜测归属。该能力只读，不会改变用户规定的 priority。Buzz 的 Nostr、公共 Relay、聊天、Git 托管、自动派发和远程 Agent 执行不在本阶段范围内。

`Devin 接入` 默认用 Devin 自带的固定 CLI 以 `--new-window --agents` 打开所选工作目录，后续任务在 Devin 原生窗口中发送。FOMO FLOW 只负责解析主进程内的工作目录句柄、打开官方应用并观测本机安全事实；Devin 自己管理其设置与扩展，FOMO FLOW App 不安装、卸载、改写或切换任何 Devin 插件。页面同时保留显式的“高级：在 FOMO FLOW 托管 ACP”：Electron main 直接充当本地 ACP Host，可以创建新的 Devin ACP 会话、选择该会话模型、发送任务，并对每次工具权限选择“只允许一次”或“拒绝”。托管模式只管理由 FOMO FLOW 新建的单个会话，不能也不会接管原生 Devin 旧聊天；完整工作路径、prompt、Authorization 和 ACP/session/tool 原始 ID 不进入 renderer 或持久化。会话模型只作用于本次 ACP 会话，不写全局 route priority；默认和高级入口都不修改 provider、model、protocol 或用户规定的 priority。托管会话的安全工作区名称、状态和实际模型会进入 `当前工作`，超过 5 分钟没有活动后只从实时桌退役，不会自动终止进程；停止必须由用户在 `Devin 接入` 明确执行。

实时观测由 Electron main 在本机候选运行时之间选择拥有最新真实请求或会话证据的数据源，renderer 只得到安全 HUD 结果和“本机端口”标签，不得到连接描述符路径。缓存命中、最近请求、告警与 Devin/Codex 会话因此不会因为桌面 App 又启动了一套空运行时而消失。Devin 工作进程内存状态断档时，main 还会只读扫描固定的本机 `agent-status` 目录，只恢复最近 5 分钟的阶段和 `modelUid/provider/upstreamModel`；原始会话 ID 先哈希，goal、环境、prompt、Authorization 与完整路径不会进入 renderer。`当前工作` 与 HUD 会话卡片会直接写明“正在使用的模型”，并同时列出渠道与路由名；临时候选只标为“候选模型 / 渠道选择中”。Devin 连接器启动新会话时优先使用显式 `DAO_ACP_API_URL`，否则选择健康的 Desktop 私有端点；已经运行的 Devin 会话不会被强制重启。缓存命中率与累计 Token 是本次运行的内存窗口，重启后重新累计；最近请求会额外保留最多 24 小时的安全样本，不含 prompt、Authorization、完整路径或原始请求 ID。

`实时情况` 中原先含糊的“任务可靠性”已改为“长任务运行情况”：这里只显示最近 5 分钟有心跳的任务登记表事实，包括运行状态、最近心跳、尝试次数、备用渠道次数和结果，不把普通聊天会话算作任务。超过窗口的任务显示为退役历史数量，可在 `任务进度` 查看，不会再被误称为“运行中”或“需要处理”。会话或任意长任务超过 5 分钟没有可信活动/更新时立即退出 `当前工作`，包括失败、超时、断连和待处理项；历史记录仍保留。这些都是展示层退役，不会自动停止 IDE 或远程代理进程。

`最近请求` 保留有界的安全请求样本，并以 `0600` 本地文件保留最多 24 小时；运行时重启后仍能继续显示最近的 provider、model、用量、耗时和结果。上游在取得 token usage 前失败或超时时，也会显示为失败请求，避免“累计调用在增长但列表为空”。这类零 token 或重启前历史样本不参与本次运行的缓存命中率计算，因此不会污染缓存指标。

`计划与验收` 只读取用户明确选择的本机 loopback Taskboard launcher，并只投影当前仓库中 `blocked / in_progress / in_review` 的安全标题、编号、状态、优先级与更新时间。连接描述符的完整路径和 challenge 不进入 renderer。FOMO FLOW 不会自动创建、更新或关闭 Taskboard 事项；`加入任务板` 必须先预览、再由用户确认，并且需要真实的当前 Codex task 归因。通过 Finder 启动而没有该归因的 App 保持只读，确认按钮会禁用并解释原因。

选中一项工作后，工作台展示已有的只读路由建议、合法 profile 来源和 provider/model/评分/原因；候选可以在当前 React 会话中上移、下移或重置，但草稿离开视图即丢失，不会自动切换渠道或保存 priority。priority 仍保持用户已经规定的顺序，只有用户进入原有配置组件、明确调整并点击保存后才会改变。安全展示统一清理 Authorization、凭据和本地绝对路径；交接只在用户点击后复制或保存，不会自动发送或写入内部 target ID、prompt、secret 与完整路径。

当前工作桌不提供暂停、重试、取消等任务写操作，也没有为这些能力新增远程服务。它不会自动改变 provider/model 或 route priority，不持久化 prompt、Authorization、完整路径或原始内部 ID。低频使用的隧道、协议与外部连接能力仍保留在 `设置` 中，但不是默认起点；用户仍可通过设置卡片或命令面板直接到达。

`ACP 协作` 不是另一张模糊的会话列表：总览并行读取现有 HUD 与任务数据，先显示安全的 Agent 名册，再显示会话、协作链和未关联任务。只有数据源提供可信关联时才建立协作关系；没有可信 session 引用的任务会明确留在“尚未关联到会话的任务”，不会用 provider/model 相似度猜关系。任务卡只展示有界标题、状态、尝试次数和产物数量；完整 prompt、Authorization、路径与原始 session/job ID 不进入界面。交接仍必须由用户明确复制或保存，FOMO FLOW 不自动发送。

ACP 工作台中的“入口能力”单独描述 Codex、Devin、ACP 和 IDE 是如何被 FOMO FLOW 观测、交接或审批；它不等同于上游路由。Agent 名册和工作舱会把来源标成 `来源 · DEVIN`，把 provider/model 标成 `上游渠道` / `上游模型`，把 model UID 标成 `路由配置名`。能力矩阵只使用安全活动证据：未看到入口时显示“尚未观测”，外部入口默认只读，只有本地 Devin ACP Host 明确显示可发送和可审批；FOMO FLOW 不会据此自动切换 provider、model 或 priority。

`流量观测`把 FOMO FLOW 作为 API 服务层与本地 IDE 之间的“控制桌”收口为五个直白页签：`最近请求`、`现在是否正常`、`运行健康`、`为什么这样走`、`问题记录`。`运行健康`是只读运维桌，汇总本机 runtime、HUD 观测源、上游渠道、Agent 会话、请求样本和 Taskboard；它可以发现陈旧、断开和降级，但不会自动重启、排空、改路由或执行远程命令。最近请求直接显示真实走过的渠道、模型、结果与安全的“缓存 / 会话亲和”标签；预算不足、渠道不可用、反复 fallback 等事实进入人工事项。发送前检查默认折叠，日常观察无需使用；准备改路由或预算时，可从已配置模型、常见用途和固定预算档位中选择后手动检查。结果中的“路由接力单”严格按规定 priority 逐跳显示可尝试、跳过原因、熔断类别与恢复倒计时；真实请求发生后仍由证据时间线核对实际 fallback。检查与真实发送共用同一纯路由规划器，但不会主动探测 provider、累计用量或改变熔断、亲和、provider/model 或 priority。建议排序与规定顺序继续分开显示。

决策箱的“已知晓 / 一小时后提醒”只管理本地提示状态，“打开路由配置”只导航到原配置组件；它们都不会自动保存路由。证据和收件箱采用有界本地记录，展示层只保留安全的 provider/model、固定原因、状态和耗时，不保存或显示 prompt、Authorization、原始 header、完整路径、session/job/request ID，也不提供远程执行能力。

The home page starts with four plain-language task cards (“现在正常吗？”, “我要接入渠道”, “我要决定模型走哪家”, “我要看任务和会话”), so a new user can choose an action without learning gateway jargon first. The `问题与数据` page is conclusion-first: it answers “现在正常吗？”, “刚刚发生了什么？”, “哪个渠道在工作？” and “要不要处理？” before placing raw field names inside a collapsed technical-details section. Profile changes on that page are comparison-only and do not write configuration or change dispatch order.

Each component calls a small allowlisted loopback API through the Electron main process. The collaboration pages are read-only control-plane views over sanitized session lineage, task attempts, fallback facts, route selection, cache/latency observations and handoff artifacts. The HUD is a component-by-component projection of the Web HUD presentation layer (runtime strip, six KPIs, session/detail cockpit, provider health, task reliability, recent requests, and sanitized warnings), rather than an iframe or copied Web page. The configuration views continue that same projection boundary: providers expose health/protocol/usage/cache/sync status, routes expose official families, external model inventory and actual-route records, reverse proxy exposes local protocol endpoints and model availability, and custom models expose runtime/capability/sync state. The older full control page remains available only from the application menu as a compatibility fallback; it is not part of the main workspace.

## macOS builds

```bash
# Unpacked Apple Silicon .app for local acceptance testing
npm run pack:mac

# Apple Silicon DMG
npm run dist:mac
```

The unpacked app is written to `desktop/release/mac-arm64/FOMO FLOW.app`; the DMG is written beside it in `desktop/release/`. This build intentionally produces an unsigned, non-notarized local app. Signing, notarization, update distribution, and CI release automation are later delivery work.

Local acceptance checks:

```bash
file "release/mac-arm64/FOMO FLOW.app/Contents/MacOS/FOMO FLOW"
hdiutil verify release/FOMO-FLOW-*-mac-arm64.dmg
```

The executable must report `arm64`, and `hdiutil verify` must report a valid checksum. Because the local build is intentionally unsigned, `codesign --verify --deep --strict` and Gatekeeper assessment are expected to fail until a Developer ID and notarization workflow are configured.

## Configuration and safety

On first start, Desktop uses:

```text
~/Library/Application Support/FOMO FLOW/
├── config/配置.json
├── config/revproxy.json
└── runtime/
    ├── endpoint.json
    ├── import-audit.json
    └── port.json
```

If Desktop state is empty and an older local config file is present, it copies `配置.json` and `revproxy.json` once. The original files remain untouched. Later starts use only the Desktop-owned copies.

如果 Desktop 已经有自己的配置，`接入渠道` 页面提供一次性的“迁移现有 FOMO FLOW 渠道”卡片。页面加载和“检查”都只生成安全预览；只有用户打开确认框并点击“确认导入”才会写入。导入以现有 FOMO FLOW 的同名渠道、自定义模型和完整路由为准，逐项保留自定义模型中的渠道 priority 顺序，同时保留 Desktop 独有渠道和 Desktop gateway。写入前会在 Desktop 私有配置目录创建 `0700` 备份目录和 `0600` 备份文件，再以同目录原子替换写入；迁移使用服务级互斥和写入前二次内容校验，运行时以精确计数和不可逆配置指纹确认热加载，未反映时提示重启而不会重复导入。迁移卡和审计不会显示或记录 API Key、Authorization、base URL、完整路径或确认 token。

该入口不是后台同步：以后源配置变化时，仍须再次进入页面、检查并明确确认。它不会探活、调用 provider、自动选择 provider/model、修改 priority 或调整 IDE/远程连接。2026-08-10 本机验收已从 25 个源渠道、9 个自定义模型和 64 条路由迁入；最终保留 1 个 Desktop 独有渠道，共显示 26 个渠道。冷启动、源配置深度等价、priority 顺序、Desktop gateway、私有权限和安全审计均已验证。

The runtime prefers `127.0.0.1:8955`, then selects a free loopback port without stopping another process. The active URL is visible in the HUD and is written only to Desktop's runtime state.

Desktop does not modify IDE settings, install certificates, alter the macOS proxy, start a public tunnel, or change Codex/other client configuration. Those connector workflows require explicit and reversible setup.

## Architecture

```text
Electron main (Bun-built, Node target)
  └─ DesktopRuntime
       ├─ Desktop-owned provider/reverse-proxy config
       ├─ existing Origin server + local model endpoints
       ├─ allowlisted IPC
       ├─ redacted dashboard projection
       └─ sanitized Web HUD snapshot projection

React + Vite renderer
  ├─ lazy-loaded native capability components
  │   ├─ 当前工作
  │   ├─ 流量观测 → 最近请求 / 运行健康 / 路由证据 / 问题记录
  │   ├─ ACP 协作 → Agent / 会话 / 协作链 / 未关联任务 / 产物
  │   └─ 设置 → providers / routes / IDE 接入 / 高级连接
  └─ narrow requestControl IPC → loopback /origin/* endpoints
       └─ /origin/hud/snapshot → native HUD presentation components

Compatibility fallback
  └─ private fomo-flow://control/ window for the full control surface
```

The Electron renderer has no Node.js access. It receives only allowlisted IPC data; the dashboard projection excludes API keys, raw provider configuration, complete endpoint URLs, and error samples. It is restricted to loopback HTTP(S) navigation; external links are handed to the system browser.

## cc-haha reference

The desktop workspace adopts cc-haha's MIT-licensed Electron/Vite/Bun pattern and its paper/ink workbench direction, while retaining FOMO FLOW's own runtime and data boundaries. It is not a cc-switch fork and does not bundle cc-haha's Claude Code runtime. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

# Dao Web → Electron 功能对照验收

- 验收日期：2026-08-10
- 目标平台：macOS arm64
- 桌面壳：Electron + React + Vite

## 结论

旧 Dao Web 的展示与控制能力已经按功能拆分为桌面原生 React 组件。旧页面仍保留为兼容入口，但不计入原生覆盖率。当前功能搬迁没有发现阻断发布的小型展示缺口；剩余事项是 macOS Developer ID 签名、公证和自动更新/发布流水线等外部发布基础设施。

桌面端现有 17 个原生视图，但侧栏只保留四个一级入口：`当前工作`、`流量观测`、`ACP 协作`、`设置`。`流量观测` 内含最近请求、运行健康、路由证据与问题记录；`ACP 协作` 内含协作总览、添加 Agent、任务与产物；`设置` 承载渠道、路由、自定义模型、IDE 接入和低频高级连接。进入隐藏子视图时仍高亮所属一级入口；所有旧能力也可通过 `⌘K` 命令面板搜索直达。系统提示词策略保留为运行时内置能力，不再提供日常独立入口。导航收口不删除旧 Web 能力、不改变未授权的远程边界，也没有用旧 Dao Web iframe 充当原生页面。

`当前工作`（`CurrentWorkControlView`）是 runtime 的默认实时桌面：每三秒并行读取同一个已选真实本机观测源的 HUD 摘要与任务数据，使用 `WorkItem` 模型只展示“需要我处理 / 正在进行 / 计划与验收”。顶部安全观测条显示本机端口、读到的会话/长任务数量及已退出实时桌数量；空态因此能明确表达“观测正常但没有 Agent 正在运行”。终态或超过 5 分钟没有可信活动的会话，以及成功、取消任务，会退出桌面但保留在历史视图；仍在时限内的验证阻塞及失败、超时、连接中断任务保留到显式确认或加入 Taskboard。`我知道了` 只在 Electron main 写 SHA-256 指纹、处理方式和时间，不保存原始 session/job ID。它不猜 session-task 关联；点击条目先在当前页展开详情、干预和任务产物，只有显式点击“打开协作会话 / 打开任务进度”才 drill-in。空态提供实时情况与接入渠道入口。

Buzz 语义层二创只吸收与“中间桌”定位一致的事件语义和工作房间思想：`DeskEvent` 将 session、request、task、Taskboard 与 approval 的既有安全投影统一成“动作、对象、结果”，`WorkCapsule` 则只收纳有不透明 owner key 的可靠关联事实。没有显式 owner key 的请求保持全局，绝不按 surface、provider、model、时间或 workspace 猜测归属。该层完全只读，不改配置 priority；Nostr、公共 Relay、聊天、Git 托管、自动派发与远程 Agent 执行均明确不吸收。

`Devin 接入`（`DevinConnectControlView`）有两个严格分开的入口。默认入口由 Electron main 调用固定 Devin CLI：`--new-window --agents <workspace>`；Dao Flow 只打开官方应用并观测本机安全事实，Devin 自己管理设置与扩展，App 不安装、卸载、改写或切换任何 Devin 插件。高级入口才由 Electron main 充当本地 ACP Host，通过打包的 Dao stdio proxy 启动官方 Devin ACP 二进制；用户可选择会话模型、发送任务、逐次允许或拒绝工具权限、取消当前任务或停止会话。两种入口都不捕获原生 Devin 旧聊天。工作目录和 ACP/session/tool 原始 ID 只留在主进程，renderer 只收到安全标签与有界事件；prompt、Authorization 和完整路径不写日志或磁盘。会话模型只影响该 ACP 会话；默认与高级入口均不修改 provider、model、protocol 或全局 priority。托管会话进入 `当前工作` 并显示实际模型；5 分钟无活动只退出实时桌，不会自动杀进程。

实时 HUD 读取采用 main-only 本机数据源选择：只在通过健康检查且返回 HUD v1 安全快照的候选运行时中，按最新真实请求/会话证据选择来源。缓存、最近请求、告警、失败统计、trace 和只读任务列表使用同一观测来源；任务列表需要的本机 bearer 只在 Electron main 获取和注入，不进入 renderer。配置、审计、备份、Taskboard、路由建议和全部写操作仍固定在 Desktop 自身运行时。renderer 只看到安全投影和本机端口标签，不获得连接描述符路径。为覆盖 Devin 工作进程重启造成的内存断档，Electron main 只读扫描固定 `agent-status` 目录并合并最近 5 分钟的安全路由事实；原始 ID 先哈希，goal、环境、prompt、Authorization 和完整路径均不投影。HUD 与当前工作卡片直接显示正在使用的上游模型、渠道和路由名，provisional 路由明确标成候选而不冒充已选结果。Devin 新 ACP 会话优先采用显式环境端点，其次采用健康的 Desktop 私有端点，既有会话不被强制中断；运行时重启会清空内存缓存窗口并重新累计。

HUD 的任务面板命名为“长任务运行情况”，只解释 Dao 任务登记表的状态、心跳新鲜度、尝试次数、备用渠道次数与最终结果，不把聊天会话混称为任务可靠性。会话超过 5 分钟没有可信活动时立即退出 `当前工作`；排队或运行中的长任务超过 5 分钟没有更新也退出，失败或断连任务只在最近 24 小时处理窗口内显示，但保留历史。这是安全的展示退役，不会自动杀掉 IDE、Devin 或其他代理进程。

`计划与验收` 只连接用户选择的本机 loopback Taskboard launcher，按当前仓库精确映射并只读投影 `blocked / in_progress / in_review`。Dao Flow 不会自动创建、更新或关闭 Taskboard 事项；显式加入必须经过预览、用户确认和真实当前 Codex task 归因。Finder 启动而无归因时保持只读。launcher 完整路径、challenge、prompt、Authorization、完整路径和原始 session/job ID 均不进入 renderer 或持久事项。

选中工作项后的干预区只承载显式动作：展示合法 advisory profile 与安全候选、在 React 内存中调整或重置候选顺序草稿，以及复制或保存经过清理的交接文本。草稿不会写 localStorage、不会切换 provider/model、不会保存 priority；统一展示 sanitizer 清理 Authorization、凭据与本地绝对路径。交接不会自动发送，并排除内部 target ID、prompt、secret 与完整路径。当前切片不提供暂停、重试、取消，不新增 endpoint、IPC 或远程服务。

`流量观测`（`TrafficControlShell`）用四个页签组织已有观测组件：最近请求、现在是否正常、为什么这样走、问题记录。最近请求明确区分真实 provider/model、请求结果和安全的“缓存 / 会话亲和”标签；`DecisionCenterControlView` 仍是本地控制面而不是自动驾驶：首屏显示“目前正常 / 有 N 项需要处理”和最近真实渠道、模型、结果，证据卡可切换查看真实 dispatch 的 plan、skip、attempt、fallback 与 outcome。发送前检查是默认折叠的可选工具，只接受现有 route UID、合法 profile、固定预算档位和固定能力标志，只有用户点击才调用无副作用 planner；结论后的“路由接力单”保持规定 priority，逐跳说明可尝试、跳过原因、白名单熔断类别和最长 24 小时的恢复倒计时，原始上游错误不进入 renderer。它不主动探测 provider、不计用量、不改变熔断、亲和、provider/model 或 priority。

`ACP 协作`（`CollaborationControlShell`）将已有能力组织为协作总览、添加 Agent、任务与产物。总览并行读取现有 HUD 与任务数据，展示安全 Agent 名册、会话、协作链和“尚未关联到会话的任务”；仅接受可信来源关系，不再用 provider/model 相似度猜 session-task 关联。任务投影只包含有界标题、状态、尝试次数和产物数量，原始 session/job ID、prompt、Authorization 与完整路径不进入 renderer。交接只由用户显式复制或保存，不会自动发送；该壳没有新增 endpoint、远程执行或自动路由行为。

## 功能矩阵

| 旧 Web 能力                                      | Electron 原生视图 / 组件                     | 状态            | 说明                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web HUD：KPI、会话、请求、渠道与缓存、任务、告警 | `实时 HUD` / `HudControlView`                | 原生已覆盖      | 从有最新真实证据的健康本机运行时读取缓存和会话；长任务面板解释心跳、尝试、备用渠道与结果。                                                        |
| 本源观照：模式、经藏、自定义注入                 | `本源` / `EssenceControlView`                | 原生已覆盖      | 独立加载与保存，不复用整页 Dao Web。                                                                                                              |
| 渠道配置：Provider 与模型目录                    | `渠道` / `ProvidersControlView`              | 原生已覆盖      | 查询、探测、添加、更新和删除均走受控本地 API。                                                                                                    |
| 既有 Dao 渠道、自定义模型与路由迁移              | `迁移现有 Dao 渠道` / `ChannelMigrationCard` | 原生新增        | main-only 安全预览、二次确认、私有备份、互斥原子合并与运行时指纹验收；不探活、不自动重排 priority。                                               |
| 模型路由：官方模型到上游模型映射                 | `路由` / `RoutesControlView`                 | 原生已覆盖      | 路由、推理强度与热加载动作已组件化。                                                                                                              |
| 模型反代：端点、模型、tier                       | `模型反代` / `RevproxyControlView`           | 原生已覆盖      | 状态、配置与交接内容均在应用内呈现。                                                                                                              |
| 内网穿透：隧道、固定域名、公网端点               | `内网穿透` / `TunnelControlView`             | 原生已覆盖      | 显式启停和配置，不在启动时隐式改系统设置。                                                                                                        |
| 协议中转站：Chat、Responses、Anthropic、Gemini   | `接口兼容` / `BridgesControlView`            | 原生已覆盖      | 协议桥列表和写操作由独立组件承载。                                                                                                                |
| 自定义模型：能力、渠道、故障转移                 | `自定义模型` / `CustomModelsControlView`     | 原生已覆盖      | 模型能力读取、增删改和手动渠道优先级草稿已接入。                                                                                                  |
| Codex 热路由                                     | `Codex 连接` / `CodexControlView`            | 原生已覆盖      | 上游与思考强度由用户显式切换。                                                                                                                    |
| 观测台：用量、trace、alert、失败统计、审计、备份 | `问题与数据` / `ObservabilityControlView`    | 原生已覆盖      | 先显示运行结论；路由建议只作比较，技术字段默认折叠。                                                                                              |
| Web 首页 / 运行状态                              | `首页` / `OverviewView`                      | 原生增强        | 增加四个小白任务入口、桌面运行时生命周期、导入状态和重试入口。                                                                                    |
| 当前工作摘要                                     | `当前工作` / `CurrentWorkControlView`        | 原生新增        | 只读聚合 HUD 与任务数据；卡片直显上游模型、渠道与路由名；不猜 session-task 关联，不暴露 prompt、secret 或完整路径，不改变 route priority。      |
| Devin 原生入口与托管会话                         | `Devin 接入` / `DevinConnectControlView`     | 原生新增        | 默认入口只打开官方 Devin；高级入口才托管单个 ACP 会话并逐次确认权限；App 不管理 Devin 插件，两者均不接管旧聊天或改全局 priority。          |
| 路由观察、决策事项与可选发送前检查               | `流量观测` / `TrafficControlShell`           | 原生增强        | 四页签组织真实请求、运行健康、路由证据与问题；检查不改 priority；ack/snooze 只管理本地提示状态。                                                  |
| ACP 会话谱系、Agent、活动、交接与未关联任务      | `ACP 协作` / `CollaborationControlShell`     | 原生增强        | Agent 名册、会话、协作链、未关联任务与产物分层展示；只使用可信关系，不猜 session-task 关联。                                                       |
| 跨代理任务生命周期与尝试记录                     | `任务进度` / `TaskCenterControlView`         | 原生新增        | 任务读取与写入需要桌面任务授权。                                                                                                                  |
| Codex / IDE 接入                                 | `连接器` / `ConnectorsControlView`           | 显式外部设置    | 仅在用户操作后写入或打开外部配置，避免静默接管环境。                                                                                              |
| 旧完整 Dao Web 页面                              | 应用菜单中的兼容入口                         | 仅兼容 fallback | 用于故障排查和过渡，不作为任何原生能力的实现依据。                                                                                                |

## 边界与安全

- Renderer 不直接获得 Node.js 能力；桌面能力通过 preload 暴露的窄 IPC 调用。
- 控制请求只允许 `http://127.0.0.1` 同源、`/origin/` 下的明确 GET/POST/DELETE 路径；任意外站、任意文件与任意代理请求不会透传。
- IPC 对 URL、文本、handoff 文件名、请求体和响应体设有格式与大小限制。
- 任务写操作需要单独授权；连接器、隧道和外部配置保持显式操作。
- `当前工作` 只读聚合既有 HUD/tasks 数据；不推断 session-task 关系，也不自动切换路由或保存 route priority。
- 路由建议只用于人工比较；当前 priority 始终保持用户已规定的顺序，必须在原有配置组件中明确保存才会持久化。
- 决策中心的预演没有 provider 调用、用量累计或运行状态副作用；收件箱与证据有界保存，Electron 只允许精确路径和严格请求体。
- 显式请求级 `cheapest` 是唯一预算顺序覆盖；默认和 `strict` 保持规定 priority，strict 全部超限时在上游调用前返回结构化 HTTP 402。
- 交接只在用户点击后复制或保存清理后的文本，不自动发送；内部 target ID、prompt、secret、Authorization 和完整路径不会进入交接内容。
- 当前工作桌没有暂停、重试、取消写操作，也没有为干预与交接新增 endpoint、IPC 或远程服务；导航收口同样只复用现有组件与路由，不新增 endpoint/IPC。
- UI 不展示完整密钥、prompt 或不必要的绝对路径；兼容页面与原生组件共享同一本地运行时，不复制第二套业务状态。
- 迁移能力只读取固定的既有 Dao 与 Desktop 私有配置位置。renderer 不能提交路径或配置对象，只能提交短时确认 token；预览和审计不含密钥、Authorization、base URL、完整路径或原始配置。迁移保持源自定义模型的渠道 priority 顺序，保留 Desktop gateway 和 Desktop 独有渠道，且不建立后台同步。有效迁移全局互斥，敏感合并草稿有数量上限和过期清理；热加载通过精确计数和不可逆配置指纹确认。

## 路由建议与人工控制契约

Electron 观测页现在读取精确只读端点 `GET /origin/ea/routing-decisions?profile=<id>&limit=<n>`。运行时返回 `{ ok: true, decisions }`；旧运行时没有 reader 时返回空数组。每条快照最多保留 20 条、每条最多 16 个候选，内存态 TTL 为 30 分钟，并标记 `mode: "advisory"`。快照只包含截断后的 provider/model/source、实际优先级、建议排序、分数因子、预算状态与最终 outcome，不保存 prompt、Authorization、原始 headers、请求路径或 session id。

Profile 只是显示镜头：`balanced`、`coding`、`fast`、`cheap`、`reliable`、`offline` 会重新计算观测排序，但不写回配置，也不改变真实流量；切换 profile 只刷新建议端点。`channelStrategy: "priority"` 继续按用户配置顺序故障转移，不自动插入会话亲和。只有两个例外会改变实际尝试顺序：已有的 legacy `random` 策略，以及调用方显式发送有效 `x-dao-budget-usd` 且同时选择 `x-dao-budget-fallback: cheapest` 时的请求级预算覆盖。预算覆盖会记录 `budget_override: "cheapest"` 与 `overBudgetFallback: true`；strict 全部超限在上游调用前返回 HTTP 402 `DAO_BUDGET_EXCEEDED`。

人工调整入口在 `自定义模型` 组件内：编辑模型后使用“手动渠道优先级”的 `置顶`、`上移`、`下移` 调整草稿，随后点击 `保存并同步` 才会持久化。观测页不会自动替用户改 priority。

## 验证记录

| 检查                                                 | 结果                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `desktop`: `npm test -- --maxWorkers=2`              | 通过，68 个测试文件 / 278 个测试；含 Devin ACP Host、真实 child 协议、严格 IPC、安全投影、HUD 合并、Buzz 语义活动流、工作舱、四入口与当前模型直显回归。 |
| `desktop`: `npm run typecheck`                       | 通过。                                                                                                            |
| `desktop`: `npm run lint`                            | 通过。                                                                                                            |
| Dao 渠道迁移 focused suite                           | 通过；服务、IPC、UI 与 Providers 集成覆盖安全预览、双 token 互斥、漂移、备份/写入失败、真实运行时指纹与显式确认。 |
| 根目录：`npm test`                                   | 通过，351 / 351。                                                                                                 |
| 决策中心 Node focused suite                          | 通过，25 / 25；含 planner parity、零副作用、持久化、endpoint 与 smoke。                                           |
| 根目录：`node --test test/dao-desktop-smoke.test.js` | 通过，2 / 2。                                                                                                     |
| 根目录：`node --test test/cache-resilience.test.js`  | 通过，1 / 1。                                                                                                     |
| 根目录：`node test/feature-coverage.test.js`         | 通过，53 / 53。                                                                                                   |
| macOS `.app` 安装与可见验收                          | 通过；arm64 App 已可恢复安装到 `/Applications`。冷启动进入当前工作，实机从本机 `:54500` 展示真实 `cccc / claude-opus-5` 缓存命中活动；选中工作只在原页展开“工作舱”，依次展示可靠活动、实际路由、建议/交接和最后的显式动作，点击“打开协作会话”后才进入 ACP。流量观测仍显示四个直白页签，ACP 明示未关联任务且不猜连线，设置保留旧能力入口；自动记忆注入文本在 main 边界清除。 |
| 既有 Dao 渠道迁移本机验收                            | 通过；25 个源渠道、9 个自定义模型、64 条路由按源 priority 迁入，保留 1 个 Desktop 独有渠道，冷启动显示 26/9/64。  |
| arm64 DMG 构建与 `hdiutil verify`                    | 通过。                                                                                                            |
| `cccc` 缓存前缀连续性                               | 通过；保持 `cccc / claude-opus-5 / openai-chat / priority` 不变，不改 Devin 插件。隐式缓存现记录有界安全前缀摘要，最近请求可区分“仅追加 / 已重排 / 新缓存族 / 待观测”；渠道卡同时展示近期与累计 HIT，旧 `{}` 样本不再显示假的 `2 ch`。Desktop 76 个测试文件 / 309 个测试通过，arm64 App 已安装并在 `:8955` 实机可见验收。 |

`test/feature-coverage.test.js` 与缓存观测 fixture 已同步当前工作区契约：缓存关联字段只接受真实十六进制摘要，瞬时 5xx 默认第 5 次才熔断；配置覆盖仍可显式设为 3。当前根目录测试与覆盖脚本均全绿。

## 交付物与剩余项

本地已生成：

- `desktop/release/mac-arm64/Dao Flow.app`
- `desktop/release/Dao-Flow-9.9.423-mac-arm64.dmg`
- DMG SHA-256：`baed70be0aa205ca4cf74543a4b8d91782a02afe52dad479026ea0084df6e050`

以下内容不属于功能搬迁，仍需外部账号或发布决策：

1. 配置 Apple Developer ID Application 证书。
2. 配置 Apple notarization 凭据并对发布包公证、staple。
3. 建立 CI 构建、制品托管、版本发布与自动更新通道。
4. 由产品所有者完成最终人工体验验收后，将相关 taskboard 项从 `in_review` 移至 `done`。

详细的开发、构建和本地验收命令见 `desktop/README.md`。

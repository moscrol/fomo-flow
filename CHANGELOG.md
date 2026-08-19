# Changelog · dao-proxy-pro

v9.9.421 · 修复 Codex 热路由任务无输出直接结束：反代不再把 reasoning-only 或完全空的上游流视为成功正文，也不会发送空 `response.completed`。仅在无正文、无工具调用时同渠道透明重试一次，仍为空则按用户配置的渠道优先级切换，所有候选均为空才返回明确 Responses 错误；正常请求零额外轮次。新增 `/codex-hot/v1/models`，返回 Codex `ModelsResponse {models:[...]}` 而不影响普通 `/v1/models` 的 OpenAI `{data:[...]}` 契约；模型元数据复用本机 Codex 原生目录，保留基础提示词、工具模式、上下文及截断能力，只同步热路由模型标识和推理强度。Claude/Devin 质量路由保持 `devin-native`，插件不追加搜索工具、不执行代理内部 continuation、不改写 Devin 工具契约。新增流式/非流式 reasoning-only 恢复、连续空响应明确失败、备用渠道切换、双模型目录契约回归。

v9.9.420 · Codex 与 Devin 文件差异双视图精确同步：⑧捕获器的同一份前后快照现在同时注册为 Devin/VS Code 原生 SCM `Codex / Devin 文件变更`，由 Devin `DiffZone` 和⑧面板共享 `filePath + beforeHash + afterHash` 指纹；绿色新增、红色删除、原生 Diff 与⑧接受/回退不再各自生成内容。点击差异前会即时重读磁盘并刷新 `afterHash`，防抖窗口内也不会打开旧内容；编辑器保存、工作区新增/删除/重命名与磁盘监听事件按来源合并为一个文件项。SCM Quick Diff 的原始侧直接读取⑧捕获的 preimage，当前侧读取真实文件；Accept 推进同一基线，Reject 继续校验当前哈希和未保存编辑器，发现 Codex 后又被 Devin/用户改动时拒绝覆盖。日志确认 `codex-acp` 处于禁用状态，旧的重复绿色差异并非本插件 ACP 适配器产生；本版不通过二次写盘伪造 ACP 工具卡，只把真实文件差异同步给 Devin 原生 SCM/DiffZone，因此不会再产生模型重写版 Diff。新增 tracker 来源/指纹与 SCM 桥单元回归。

v9.9.419 · 修复 ⑧ Codex 专用 Responses 入口返回 `404 page not found`：9.9.418 已在 `revproxy.handle()` 与 `_maybeRevproxy()` 内层登记 `/codex-hot/v1/*`，但主 HTTP `_mainHandler` 的外层分发门控仍只放行 `/v1/*`、`/v1beta/*` 与 `/origin/revproxy/*`，导致请求尚未进入反代即落到默认 404。本版将 `/codex-hot/v1/*` 加入主分发器，并新增静态回归要求外层、内层两个门控同时存在，再保留真实 HTTP 回归验证 kfcoding + Responses + high。运行时锚点升为 9.9.419，避免复用已加载的 9.9.418 服务。

v9.9.418 · ⑧ Codex 热路由按用户现有配置收窄接管范围：保留当前 `model_provider`、`model`、`model_reasoning_effort`、上下文窗口、notify、认证模式与其余 TOML 内容，只将当前 provider 段的 `base_url` 和 `experimental_bearer_token` 一次性指向独立 `/codex-hot/v1` Responses 入口；首次让正在运行的 Codex 重新加载一次后，②渠道配置每张渠道卡新增“⑧Codex”快捷切换，之后渠道、真实模型、协议和推理强度只更新插件运行态，无需再次重启 Codex。专用入口按独立热路由选择上游，不写入或覆盖③同名模型路由，也不受④对外模型开关影响；真实 HTTP 回归验证同名 xAI 路由存在且模型被④禁用时仍只命中用户选定的 kfcoding，并将用户选择的 `high` 覆盖发送为上游 Responses reasoning effort。已安装 9.9.415-417 内部别名接管的用户会从既有 `.dao-proxy-pro.bak` 自动恢复原 Provider、模型和推理强度后迁移到新入口。运行时版本锚点同步为 9.9.418，防止 Devin 误复用旧后端进程。

v9.9.417 · ⑧新增“工作区变更审查”，自动捕获 Codex、Devin 保存及外部程序对当前工作区文件的新增、修改和删除，并在 Devin 插件面板中集中显示 `A/M/D/?` 状态、增删行统计、工作区根目录与捕获阶段。支持多根工作区、工作区切换自动重建、单文件/全部接受、单文件/全部回滚，以及打开 Devin/VS Code 原生绿红差异编辑器；回滚前校验磁盘哈希和脏编辑器，避免覆盖捕获后产生的新修改。Unity 根目录 `Library/Temp/Logs`、依赖/构建目录、二进制文件、超过 2 MB 的文件会被忽略，但不会误伤 `Assets/Library`。捕获在扩展激活后异步启动，不增加任务生成链路延迟。受 Devin ACP 能力边界限制，Codex 已写入磁盘的外部变更不能补造原生 ACP Diff Zone，本模块提供等价审查流程；“接受”表示保留当前磁盘内容并推进基线，“回滚”恢复捕获前内容。

v9.9.416 · ⑧ Codex 热路由新增“Codex 实际配置”自动同步视图：面板打开时每 3 秒只读取一次轻量状态，显示 Codex 当前 `model_provider`、模型、推理强度、`wire_api` 和 Base URL；若用户在 Codex 配置侧改动，Devin 面板会自动显示真实值与⑧保存路由是否一致，不重复探测渠道或模型。同步接口只返回非敏感字段和“是否存在 Provider Token”，不会返回密钥正文。热路由继续只修改 `~/.codex/config.toml`，不读取、不写入 Codex 认证缓存、账号登录状态或线程历史存储，因此原账号登录与既有聊天记录保持原样；新增回归以独立认证文件和历史文件验证应用、二次热切换和外部配置同步前后字节完全不变。

v9.9.415 · 新增与原七个模块并列的“⑧ Codex 热路由”：②渠道配置中的渠道可通过稳定的本地 Responses Provider 接管 Codex。首次接管会备份并更新 `~/.codex/config.toml`，需要重启 Codex 一次；之后切换渠道、模型、上游协议和推理强度只更新插件内部路由，不改变 Codex 的稳定本地 URL/密钥，也无需再次重启。`grep_search` 的匹配正文不再写入 Devin 会话界面，但完整工具结果仍回灌模型并保留跨轮轨迹/缓存。`code_search/Fast Context` 继续由 Devin 原生执行，插件只把 Windows 外层路径规范为正斜杠，中文与英文查询正文均原样透传。旧版 9.9.353 仅有 Anthropic cache-control，没有更优的 OpenAI 缓存实现，因此继续保留当前 Responses `prompt_cache_key`、连接亲和与 `dao-output://` 大型工具输出持久化。

v9.9.414 · Fast Context 查询正文恢复 Devin 官方原样透传。此前 9.9.410/411 为规避 Windows 嵌套工具 JSON 反斜杠错误，会在每个 `code_search.search_term` 末尾追加路径与结果范围约束；连续实机日志确认外层路径已正确交付，但原生执行器仍对带附加约束的查询返回 `Error: the Fast Context search failed`。本版删除查询正文改写，仅保留必要的 Windows 外层绝对路径正斜杠规范化；模型生成的搜索词、Devin 原生工具名、索引、执行和结果均不再由代理干预。不增加重试或模型轮次，不改变 9.9.412 缓存策略，并保留 9.9.413 的 Unity `.codeiumignore` 修复。

v9.9.413 · 修复 Unity 工作区 `.codeiumignore` 中未锚定的 `Library/` 同时误伤项目资源目录 `Assets/Library/`，导致 `PPT.uxml` 等 UXML/Prefab 可被 `find_by_name` 定位、却被 `read_file` 禁止并令 Devin 原生 Fast Context 返回 `Error: the Fast Context search failed` 的问题。插件启动及多根工作区新增目录时只检查根目录现有 `.codeiumignore`，仅把精确规则 `Library/` 原子改为 `/Library/`；不创建忽略文件、不扫描项目内容、不重启 Devin、不替换或模拟 Fast Context，其他用户规则和换行保持不变，重复启动零写入。9.9.412 的 Responses 工具输出持久化与缓存策略保持不变；回归覆盖规则纠正、用户内容保留、幂等零写入和缺失文件。

v9.9.412 · 修复长对话连续读取文件后输入上下文膨胀、工具调用后的上游缓存命中率骤降。日志确认 27 次调用累计输入 426.8 万 token、单次输入由约 10.3 万增长到 25.6 万，而 `cacheKey/system/tools` 哈希始终稳定；根因是历史大型工具结果一直完整内联，`toolOutputStore` 在普通 Responses 质量路由中从未启用。本版对所有 Responses 路由默认持久化较早且超过阈值的工具结果，使用内容哈希生成稳定 `dao-output://` 引用并保留路径、行号所在的头尾预览；最近 4 条工具结果仍完整内联，保证模型立即使用刚读取的代码。`dao_read_tool_output` 作为固定工具稳定加入 Responses 请求，普通路由与自定义模型均可按需分段回读全文；`persistToolOutputs:false` 可恢复完全原生内联。没有替换 Devin 的 `find_by_name/grep_search/read_file/code_search` 执行器，不增加搜索轮次，也不启用本地 Fast Context。新增默认启用、最近窗口、确定性引用、普通路由回读工具、显式关闭、工具调用/结果配对及原生契约回归。

v9.9.411 · 优化 Devin 原生 Fast Context 的结果范围。Windows `code_search` 的固定幂等 guard 在保留 9.9.410 内部路径安全规则的同时，要求原生搜索子代理仅返回最小相关符号范围、禁止整文件、最多 8 个文件且每文件最多 80 行，并把进一步细节交给 `grep_search/read_file`。插件不裁剪、不改写工具结果，也不替换 Devin LSP/Cortex；目标是减少超大 Fast Context 返回造成的上下文膨胀、后续截断与响应变慢。

v9.9.410 · 修复 Devin Windows 原生 Fast Context 外层路径已为 `E:/...` 后，内部搜索代理仍可能生成 `Assets\\Runtime...` 一类带反斜杠的嵌套工具 JSON，并由 `instant_context_agent.go` 报 `invalid character 'R' in string escape code` 的问题。插件现在只为 Windows `code_search` 查询追加稳定的内部路径约束，要求嵌套工具使用工作区相对路径或正斜杠绝对路径；调用、索引和语义检索仍完全由 Devin 原生 LSP/Cortex 执行，普通 Grep、文件读取及其他工具不受影响。

v9.9.409 · 更正 9.9.408 对 Devin Windows Fast Context 路径契约的判断。实机回归确认 `search_folder_absolute_uri` 虽以 URI 命名，但当前执行器使用 Windows 原生绝对路径校验，`file:///E:/...` 会被判为“非绝对路径”；同时原样 `E:\...` 又可能在 Fast Context 内部子代理的嵌套工具 JSON 中形成 `\R` 等非法转义。现在统一发送 `E:/...`：保持 Windows 绝对路径语义，同时消除反斜杠转义风险。相对目录解析后的 `code_search` 路径也使用同一格式；Fast Context 仍完全交由 Devin 原生 LSP/Cortex 执行。

v9.9.408 · 修复 Devin 原生 `code_search / Fast Context` 在 Windows 项目路径下偶发 `Skipped`。日志确认插件已将 `code_search` 作为原生 LSP 工具交付，但 Devin `instant_context_agent` 随后报 `Error parsing tool call arguments: invalid character 'R' in string escape code`；根因是 `search_folder_absolute_uri` 已为绝对路径时，旧逻辑原样透传 `E:\...`，原生子代理在嵌套工具 JSON 中再次使用该路径时可能把 `\R` 等片段解析为非法转义。现在只对名称含 `uri` 的搜索路径字段统一规范为 `file:///E:/...`，`grep_search`、`find_by_name`、`read_file` 和其他 Devin 原生工具契约保持不变；Fast Context 仍完全由 Devin LSP/Cortex 执行。新增绝对路径到 file URI 的回归测试，并为 Unity/SVN 工作区加入官方 `.codeiumignore`，排除生成目录及版本库元数据后，候选索引文件由 28,393 降至 2,239。

v9.9.407 · 修复本地 `grep_search` 与任意 Devin 原生工作区工具同轮出现时的 Fast Context 后续竞态。真实任务通常先生成 `find_by_name + grep_search`，旧逻辑只对同轮已经出现 `code_search` 的情况优先交付；因此插件仍可能执行本地 Grep 后发起内部 Responses continuation，并在该内部续跑中首次生成 `code_search`。这种原生工具帧处于代理 continuation 后半段，Devin/Cortex 可能直接标记为 `Skipped`。现在 `grep-only` 模式只要同轮存在本地 Grep 与任意原生 LSP 工具，就立即执行并保存本地 Grep，同时把原生工具帧交回 Devin，绝不启动并发 continuation；Fast Context 只能在下一次干净的 Devin 原生工具轮次中生成和执行。纯本地 Grep 必须续跑时，内部请求会移除 `code_search/SmartReading`，防止代理内部首次发起原生语义检索。新增真实三轮回归：`grep_search + find_by_name`、原生 `find_by_name` 结果回传、独立 `code_search` 调用及结果回传；同时验证没有代理占位结果、没有额外上游请求，且本地 Grep 结构化轨迹按顺序恢复。Fast Context 仍完全使用 Devin 原生索引和执行器。

v9.9.406 · 修复本地 `grep_search` 与原生 `code_search/Fast Context` 在同一模型响应中并发时的执行竞态。旧逻辑会为了执行本地 Grep 暂存整批原生工具调用并进行上游续跑；如果模型没有在续跑响应中再次生成 `code_search`，Devin 原生执行器收不到第一次 Fast Context 调用，界面会显示 `Skipped`。现在检测到混合调用后立即把 Fast Context 原生帧交给 Devin，不启动并发上游续跑；本地 Grep 仍在插件内执行、可见展示并按 Cascade 保存结构化调用/结果，下一次 Devin 返回 Fast Context 结果时再恢复到原生调用之前。没有替换或模拟 Fast Context，工作区索引、语义检索和结果执行仍完全由 Devin LSP 负责。新增同响应 Grep + Fast Context、原生工具结果回传、无占位结果和跨轮轨迹顺序回归。

v9.9.405 · 整理本地 Grep 的会话展示：修复普通换行被 Devin Markdown 折叠后，27 条命中挤成一个超长段落且每条重复完整绝对路径的问题。结果现在显示为紧凑摘要（查询、命中数、文件数）、一次根目录，以及保持换行的 `text` 代码块；匹配按文件分组，文件使用相对路径，每个文件仅显示一次，下面按“行号 | 源码”排列。仅修改可见呈现，9.9.404 的跨轮结构化轨迹、Fast Context 原生执行和缓存前缀保持不变。

v9.9.404 · 修复 `grep-only` 本地 Grep 在后续 Devin 工具轮次中“已经执行却再次被判定未执行”的跨轮轨迹缺口。日志确认 Grep 一直由插件成功执行，但内部调用和结果只存在于当次 Responses continuation，Devin 保存的会话历史只有后续 `code_search/read_file`，下一轮上游因此看不到 Grep 证据并重复调用。现在插件按稳定 `cascadeId` 保存最小结构化 Grep 调用/结果，在后续请求中恢复到对应原生工具调用之前，使上游历史与前一轮 continuation 保持一致并维护缓存前缀；状态有两小时 TTL、会话与组数上限。与此同时，真实 Grep 范围、命中数、文件路径、行号和源码片段会作为可见结果块写入 Devin 对话，最长显示 48 KiB，完整结构化结果仍交给模型。`code_search/Fast Context`、`find_by_name`、`read_file` 继续走 Devin 原生 LSP。

v9.9.403 · 修复本地 Grep 工具续跑后的重复叙述与静默截断：窄 `grep-only` 模式执行本地 `grep_search` 后，不再把该轮尚未完成的助手步骤文字或隐藏推理回灌到 Responses continuation，避免模型在下一轮重复“第 2 步尚未执行”或输出互相矛盾的进度。上游 HTTP 200 但 SSE 中没有文本、推理、工具调用和完成原因时，不再视为成功结束；插件会原请求自动重试一次，第二次仍为空则向 Devin 返回明确错误帧，防止对话无提示截断。`code_search/Fast Context` 继续完整保留为 Devin 原生 LSP 工具，插件仅接管已验证工作区内的 Grep。新增真实 Responses function-call 续跑与空流恢复/失败集成回归。

v9.9.402 · 修复 9.9.401 在真实 Devin 请求中未触发的问题：Cortex 的“无活动工作区”状态可能只在 Grep 执行后返回，官方 system prompt 不一定包含固定英文文案，因此不能把该文案作为唯一前置条件。现在只要请求中存在经过存在性验证的工作区根目录，插件就进入窄 `grep-only` 模式；仍仅接管 `grep_search/Grep/GrepSearch`，并要求搜索目录已经归一化且位于这些根目录之内。`find_by_name/read_file/list_dir` 继续走 Devin 原生工具，工作区外绝对路径、无效路径和多根歧义路径不接管；不启用 `code_search/Fast Context`，不增加模型重试。针对无固定 system 文案的真实场景新增回归覆盖。

v9.9.401 · Devin 空工作区 Grep 窄兜底：实机回归确认 `find_by_name` 与 `read_file` 已获得正确绝对路径并正常执行，但 Devin Cortex 的 `grep_search` 使用独立工作区注册表；当官方 system prompt 明确写出 `The USER does not have any active workspace.` 时，即使 ACP 与项目提示词已有有效根目录，Cortex 仍会拒绝为 `not within any current workspace`。本版仅在该官方元数据明确为空、且从 system prompt 或 `DAO_WORKSPACE_ROOT(S)` 得到经过存在性验证的根目录时，提前由插件本地执行 `grep_search/Grep/GrepSearch`；`find_by_name/read_file/list_dir` 继续由 Devin 原生执行，`code_search/Fast Context` 不启用，正常工作区不接管，多根同名相对路径不猜测。该兜底只复用模型原本的一次工具结果续跑，不增加额外模型重试，并继续隐藏 `DELTA_THINKING`。新增 `grep-only` 单元与真实双轮路由集成回归，确认本地结果回送上游、原生工具契约保留且内部推理不外显；核心闭环 347/347、工作区策略 32+15+13、ACP、工具/上下文/缓存/项目提示词与 Webview 回归全部通过。

v9.9.400 · Devin 原生工作区搜索路径修复：确认项目已在 Devin 打开且 ACP 已注册，但官方 system prompt 仍可能显示无活动工作区，模型因此把 `grep_search/find_by_name` 的路径写成 `Scripts`、`/Scripts` 或 `\Scripts`；旧归一化又把 Windows 根相对路径提前视为绝对路径，中文“项目根目录”识别规则还存在乱码，导致原生搜索器拒绝为“outside a currently open workspace”。现保留最近一次有效的 `workspaceFolders`，窗口 Reload 的短暂空状态不再清除路由器根目录；搜索参数在交给 Devin 原生执行器前按最近成功目录、工作区根及一层子目录依次消歧，Unity 的 `Scripts` 稳定映射到 `Assets\Scripts`，多根工作区存在同名目录时仍不猜测。只在异常路径未能修复时记录字段、原因和候选根，不启用代理搜索、不增加模型请求或内部重试。真实 `E:\新增运行时状态机` 验证三类路径均正确，单次归一化约 1.6-2.8ms；核心闭环 347/347、工作区策略 32+15、ACP 与路径回归全部通过。

同版调整路由模型的可视输出：上游仍按配置执行 `reasoning.effort`，代理内部仍保留同次工具续跑所需的 reasoning，但默认不再向 Devin 写入 `DELTA_THINKING`；普通思考、内部工具续跑和空闲保活均不会显示“Thought for …”。保活改为元数据帧，不增加等待或请求；设置 `DAO_EXPOSE_REASONING=1` 可恢复旧显示。

v9.9.399 · Devin 原生质量契约：使用日志确认截图对应请求始终为 `kfcoding/gpt-5.6-sol`、OpenAI Responses、`reasoning.effort=high`，缓存命中从冷启动 5.6% 恢复到 94%–99%，降智并非缓存返回旧答案。根因是项目提示词此前整体替换 Devin 官方身份与执行规则，只抽取最小工具/OS/工作区片段；现改为完整保留 Devin 官方 system prompt，仅在末尾维护一个稳定的 `<dao_project_instructions>` 项目区块，切换项目时替换该区块而不叠加。`devin-native` 路由同时停止补造缺失的工具结果，消息历史、工具定义与真实工具结果均以 Devin 原文透传；旧兼容修复仅保留给显式 `proxy-managed` 路由。没有增加模型轮次、代理搜索或额外重试，缓存键和 Responses high 保持不变。

v9.9.398 · 工作区根随请求传递：修复扩展已注册 ACP 根但当前路由调用仍无法补全 `Assets` 的遗漏。路由现从当前请求的官方 `<workspace_information>` 或项目提示词 `项目根目录/工作区目录/Workspace root/Working directory` 提取并校验真实目录，把该会话专属根直接传入工具参数归一化；不再只依赖扩展宿主环境状态。实机使用当前 Unity 项目提示词验证 `Assets → E:\新增运行时状态机\Assets`，同时保留 ACP 环境、多根消歧和最近搜索目录三重来源。

v9.9.397 · 多根工作区路径消歧：`.code-workspace` 同时打开多个项目时，全部根目录继续注册给 ACP；相对搜索路径优先跟随同一对话最近一次有效项目目录，仅当工作区根中唯一命中时才自动补全。若多个项目都含同名 `Scripts`/`Assets`，不再默认选择列表中的第一个项目，避免静默搜索错仓库；无文件夹窗口会清除扩展宿主中残留的旧工作区根。

v9.9.396 · Devin 原生搜索相对路径修复：ACP 注册工作区根现在同步给同进程路由器；模型调用 `grep_search`、`find_by_name`、`CodeSearch` 等原生搜索工具时，若误把 `E:\项目\Assets` 的后续目录写成 `Scripts`，路由会在发往 Devin 前优先按同一对话最近成功目录解析为 `E:\项目\Assets\Scripts`，其次按 ACP 根目录解析，最后仅做最多 25ms/600 目录的唯一匹配。绝对路径与非搜索工具逐字保持不变，同名目录不猜测，仍由 Devin 原生执行器完成搜索，不增加模型请求或失败重试轮次。

v9.9.395 · 自定义模型配置单一真源：模块③引用或直接编辑⑦自定义模型时，渠道新增、编辑、删除、拖拽排序、随机/优先策略与思考强度会先写回⑦注册表；普通路由仅保存 `_customModelRef` 动态引用，不再复制渠道导致配置漂移。模块④模型反代与⑥协议中转站同步显示⑦完整渠道链、协议、思考强度和优先顺序，修改后无需重建反代或中转档案。③提供“改为独立路由”显式入口，避免无意解除共享。

v9.9.394 · 路由多渠道策略：模块③和自定义模型均支持用户添加、编辑、删除及拖拽排序多个渠道；默认按优先级故障转移，也可选择“随机首选（会话内保持）”。随机模式仅在用户显式配置的渠道中为新会话选取首选渠道，后续工具回合保持同一渠道，失败后再按当前随机队列切换，兼顾渠道分散、上下文连续与缓存命中。普通路由不再扫描未配置的同模型 Provider，修复 kfcoding 失败后擅自切到 XAI。模块③顶部同步显示实际 Provider、模型、协议、思考强度及渠道策略；路由保存同步全部折叠 UID 和 `MODEL_*` 别名，Responses 质量路由继续强制传递用户选择的 `reasoning.effort`。

v9.9.393 · 模型路由思考强度可编辑：模块③的已连接路由直接显示当前思考档位并提供编辑入口，路由弹窗按实际 Provider/模型探测可用档位，正确回填旧配置中的 reasoningLevel/reasoningEffort；保存时保留既有协议、备用渠道和自定义模型标记，由统一能力映射生成 Responses reasoning.effort、Anthropic/Gemini thinking budget 或兼容协议参数。新增弹窗内删除路由入口，窄面板下目标模型自动省略，避免控件挤压。

v9.9.392 · Devin 原生上下文与工具契约优先：根治同一对话间隔后丢失上下文、重复定位文件和代理缓存策略拖慢执行。日志确认从未触发 token checkpoint，实际问题来自路由前无条件删除 conversation summary/记忆与侧信道字段、改写工具描述，以及路由后叠加本地大输出引用、MCP 延迟发现、工作区失败状态机、代理 checkpoint 和服务端工具内部重试。默认执行链现只做用户要求的项目 system prompt 替换、协议转换、路由和推理强度映射；Devin 提供的完整消息历史、官方摘要、工具定义、工具结果与工作区状态逐字透传，不再注入 `dao_tool_search`/`dao_read_tool_output`，不再把大结果替换成 `dao-output://`，不再生成代理 checkpoint 或修改工具描述。稳定 `prompt_cache_key` 与连接复用继续保留，由 Responses/上游官方缓存处理增量前缀。旧代理策略保留为显式 `contextStrategy.mode="proxy-managed"` 兼容模式，新建自定义模型默认为 `devin-native`。新增真实 Responses 回归：900 行工具结果原样内联、工具名称/数量完全等同 Devin、无代理内部重试；protobuf 回归验证项目提示词注入仅修改 system prompt，工具与 conversation summary 字节不变。

v9.9.391 · GPT-5.6 Sol 质量路由与原生工具契约修复：所有映射到 `gpt-5.6-sol` 的思考/质量型普通路由统一在配置加载、热保存和真实请求三层规范化为 OpenAI Responses，已保存的 `low/medium/high/xhigh` 会真实转换为 `reasoning.effort`，不再被陈旧的 `thinkingEnabled:false` 覆盖。历史 `thinking/high/medium/low` 路由若尚无明确档位，会从路由 UID 恢复档位；明确选择 `off` 仍保持关闭。新增普通路由集成回归，验证第三方渠道默认 Chat、旧普通路由无显式协议时最终仍请求 `/v1/responses`、携带 `reasoning.effort:"high"`，并完整保留 Devin 原生工具定义。项目提示词注入改为只替换项目正文，同时从原生系统提示中保留最小工具、操作系统、引用格式和工作区契约；原生身份与风格正文仍不进入上游。

v9.9.390 · 修正“当前实际使用”状态的页面归属并重组大型 Webview 客户端：活动自定义模型、真实渠道、真实上游模型和自动切换来源原先误放在⑥协议中转站，现移动到⑦自定义模型顶部，与其数据加载和 2.5 秒实时刷新生命周期统一；⑥只保留协议中转接入、转换配置和全链路测试。将原 147 KB/2187 行 `ea-config-client.js` 按职责拆为渠道与路由核心、协议中转与自定义模型、模型反代、内网穿透四个功能文件，通过小型清单按原顺序无损拼装，降低跨模块修改冲突。新增模块清单、状态节点唯一性、页面归属和生成后 Webview 语法回归。

v9.9.389 · 修复代理工具内部重试达到上限后 Devin 只输出计划/状态、未完成编辑即结束：旧逻辑在第 3 次代理侧工具重试时把整个 `tools` 字段删除并强制 `tool_choice=none`，连 `read_file/edit/multi_edit/write_to_file/run_command/list_dir` 等 Devin 原生执行工具也被误禁用。现在达到上限时仅屏蔽反复触发循环的代理本地搜索与延迟工具，保留全部可用的 Devin/LSP 原生工具和连接器工具，并明确要求模型完成修改与验证后再总结；只有确实没有剩余客户端工具时才进入无工具收尾。新增重试上限集成回归，验证第 4 次请求仍携带读写/终端工具、代理搜索工具已移除、客户端工具调用可正常返回且流式响应完整关闭。

v9.9.388 · 修复 Devin 已打开项目但原生搜索仍提示没有工作区：ACP 代理不再依赖 VS Code `workspaceFolders` 才启用转换；当环境变量未提供根目录时，从 `session/new.params.cwd/additionalDirectories` 推断工作区，并把有效 cwd 显式注册到 `additionalDirectories`，覆盖 Devin Desktop 项目窗口与扩展宿主工作区状态不同步的情况。新增空环境变量、多工作区和分片 ACP 输入回归。

v9.9.387 · 修复 Responses 多模态请求 502/503：Devin/Cascade 提供的 Chat 图片块 `{type:"image_url", image_url:{url}}` 现在会转换为 Responses 原生 `{type:"input_image", image_url:"..."}`，文本块同步转换为 `input_text`；系统提示改用 `instructions`，无状态调用发送 `store:false`，推理摘要字段改为 Codex 兼容的 `reasoning.summary`。实测同一截图旧格式返回 Cloudflare 502，修正格式返回 200；5 张图片、约 1.18 MB 的正确格式请求同样返回 200，排除请求体积误判。新增多模态形状、系统提示、存储与推理字段回归。

v9.9.386 · 修复自定义模型 Responses 协议、搜索拦截与工具续跑：协议适配器不再复用其他协议的 `completionPath`，选择 Responses 时即使渠道保存了 Chat 路径也固定发送 `/v1/responses`，并保留自定义模型的推理强度；本地工作区搜索仅在原生 Cortex 明确返回工作区未注册后接管，健康会话继续走 Devin 原生工具；连续代理工具达到三轮上限时，最后一轮执行完工具后撤下工具定义并强制生成最终答复，不再静默关闭导致回复停在分析阶段。新增协议路径、健康/降级搜索分流及工具重试上限集成回归。

v9.9.385 · 自定义模型优先级渠道支持原位编辑：可直接修改渠道、上游模型、协议和思考强度，保存后保持原优先级顺序；每个备用渠道独立保存并在故障切换时携带自己的协议与思考参数，兼容旧配置并新增回归覆盖。

v9.9.384 · 原生 Cortex 工作区索引失步兜底：实机确认 `9.9.383` 已把 `E:\新增运行时状态机` 注入 ACP `session/new.cwd`，但 Devin 独立搜索执行器仍返回空工作区，证明该执行器没有采用 ACP 根目录，而非插件版本未生效。对带有真实绝对目录的 `CodeSearch/code_search`、`Grep/grep_search`、`FindByName/find_by_name` 与 `SmartReading` 增加代理侧本地执行：目录存在时拦截并在 1.8 秒、5000 文件、80 结果、单文件 2MB 的硬边界内完成文件名、文本或相关文件检索，通过既有服务端工具内部重试把结果交还模型；虚拟/不存在路径仍走原生 LSP，不改变正常工具分类。自动跳过 `.git/node_modules/Library/Temp/obj/bin` 等生成目录，不使用外部 shell，不再因 IDE 索引注册表为空而退化成大范围 PowerShell 搜索。旧失败已存在于当前对话历史时，熔断器不再隐藏搜索工具，而是注入本地恢复状态并允许用同一绝对根目录重试，因此无需新建对话。新增中文路径、file URI、文件名、行号文本、代码相关性、路由器接管与旧对话续接回归；核心闭环 347/347、工作区策略 32+15 与缓存回归全部通过。

v9.9.383 · 大文件功能拆分与 ACP 工作区注册修复：①将 `extension.js` 内完整的七模块 Webview 生成器移到 `ui/ea-config-html.js`，扩展入口由约 7,685 行降到约 4,897 行；②继续按职责拆为 `ui/ea-config.css`、`ui/ea-config-client.js` 和 HTML 组装器，完整/折叠两种页面在拆分前后长度与 SHA256 均逐字节一致；③将 `dao_router.js` 的自定义模型列表、能力探测、增改、删除和目录生成移入 `custom_model_registry.js`，通过依赖注入访问热配置状态，主路由不再承担注册表实现；④Webview 测试直接引用 UI 模块，新增代码结构索引；⑤修复编辑器已打开项目、但独立 ACP/Cortex 搜索执行器仍显示空工作区的问题：启动钩子把当前单根/多根文件工作区写入 ACP 环境，stdio 代理按原生协议补全 `session/new.params.cwd/additionalDirectories`，已有正确工作目录保持逐字节不动，错误或缺失目录才修复；NDJSON 分片、中文路径、普通 ACP 与 summarizer 进程均有回归。自定义模型、多渠道故障转移、缓存、Webview、工作区策略与核心 347 项回归全部通过。

v9.9.382 · 修复⑦“实际渠道已经切到备用，但页面仍显示尚无运行记录”：后端 `/origin/ea/custom-models` 已正确返回最近实际渠道，旧前端却只在打开/手动刷新时读取一次，运行请求完成后不会更新。模块 7 现增加醒目的“当前实际使用”状态条，并在页面处于活动状态时每 2.5 秒轻量拉取一次本地运行状态，不重载渠道目录、不覆盖正在编辑的表单；成功时显示真实 `provider/model` 及“首选渠道/自动切换到备用/会话保持”，全部失败时显示红色告警。已注册模型卡片同步实时更新，不再需要用户手动点击刷新。

v9.9.381 · 自定义模型多渠道优先队列：⑦自定义模型可为同一 Devin 模型配置最多 16 组“渠道 + 上游真实模型”，支持鼠标拖拽、置顶和移除，列表从上到下即故障转移优先级。运行时只在用户明确保存的队列内切换，不再扫描任意同名渠道；首选失败后依次尝试备用，备用成功后按 Cascade 会话保持以稳定提示缓存，当前渠道失败时重新回到优先队列尝试其他渠道，单次请求不会重复同一渠道/模型。用户拖动并保存新顺序后，旧渠道粘性立即失效，下一次请求从新的第一项开始。模块列表新增“最近实际渠道/全部渠道失败”状态；所有配置渠道均失败时通过扩展宿主弹出一次去重告警，并可直接打开外接 API 设置。旧单渠道模型自动兼容为一项队列。新增主失败→备用成功、备用继续粘性、全部失败事件、拖拽重排主渠道、多渠道持久化与删除引用保护回归。

v9.9.380 · 修复自定义模型渠道被静默替换：实机日志确认 `dao` 配置始终为 `kfcoding/gpt-5.6-sol`，但 kfcoding 首次返回一次 `503 model_not_found / 无可用渠道` 后，自动同模型故障转移切到安域AI，并被两小时会话粘性长期排在主渠道之前；主渠道 30 秒熔断结束、用户重新保存模型后仍继续走安域AI。自定义模型的渠道现视为模型身份的一部分，默认严格绑定所选 provider，主渠道失败时回传真实错误，不再静默跨渠道；只有显式 `autoFallback:true` 或配置了明确备用渠道才允许切换。新建/更新自定义模型会持久化 `autoFallback:false`，旧配置即使缺少该字段也按严格绑定处理，既有错误粘性会自动失效。新增主渠道 403、备用渠道 200 的双场景集成回归，验证普通路由仍可故障转移，而自定义模型只调用指定渠道。

v9.9.379 · 修复“项目明明已打开却提示不在工作区”：实机请求证明 Devin 主窗口和语言服务器已经注册项目，但 `grep_search` 使用的独立 Cortex 工作区表为空，返回 `Search path ... is not within any current workspace / Current open workspaces:`。旧策略既未识别这条真实错误，也把同样受工作区约束的 `Grep/grep_search` 当作降级工具继续推荐，导致重复失败并误导模型声称项目未打开。现将 `Grep/grep_search` 纳入会话级工作区熔断，识别真实空工作区错误后与 `CodeSearch/SmartReading` 一并从后续工具集合移除；稳定指令明确区分“编辑器已打开项目”和“搜索执行器注册表失步”，降级只使用 `Read/FindByName/ListDir` 与项目根目录下的窄范围命令，不再重复调用失败工具。

v9.9.378 · 修复 Devin 持续 `Connecting to server...` 的 LS 状态机竞态：ACP 模式已经通过 spawn hook 为每次语言服务器启动改写本地 API/推理地址，却仍在代理就绪 15 秒后写入 `settings.json`。当上一宿主正常关闭清除锚点后，下一次启动会恰在首个 LS 初始化途中改配置，Windsurf 排队重启并产生双 LS；第二个实例虽成功，前端仍粘在第一个已关闭端口并持续 `ECONNREFUSED`。ACP 模式现改为仅内存锚定，完全不在启动期写设置；非 ACP 模式保持原逻辑。文件 IPC 同时改为读取即删除，防止 `reloadWindow` 等一次性命令在新宿主中重复执行形成重载循环。

v9.9.377 · 修复重启后长期“连接服务”：端点发现文件此前在 `net.Server` 的 `listening` 回调中调用完整内网穿透状态，依次同步探测 7 个本地代理端口并执行 `cloudflared --version/where`，实测阻塞监听完成约 24 秒，导致 Devin 首次语言服务器启动超时，失败进程未退出后又拉起第二实例。启动期现改为只读缓存、PID、日志和配置文件的快速快照；完整代理/二进制探测仅在模块 5 状态页或用户主动操作时执行。新增真实临时端口冷启动回归，要求监听在 5 秒内完成。

v9.9.376 · 项目提示词跨升级持久化：修复自定义/项目提示词活动正文保存在扩展版本目录 `vendor/bundled-origin/_custom_sp.json`，安装新 VSIX 或 Reload Window 后项目列表仍在、但当前注入状态变为 `custom_sp=false` 的问题。活动提示词现统一持久化到 `%USERPROFILE%\.codeium\dao-byok\custom-sp.json`；首次启动自动扫描既有 `dao-agi.dao-proxy-pro-*` 版本目录，按最近修改时间迁移最后一份有效提示词，保留 `project_id/project_path/replace_all` 等项目元数据。用户清除提示词时写入显式 tombstone，防止旧版本目录在后续启动时把已清除内容再次恢复。新增迁移、跨版本读取、清除防复活和重新保存回归；升级后无需重新点击“注入 Devin”。

v9.9.375 · 外部项目与续跑连续性：①修复项目提示词已写明绝对路径，但 `CodeSearch/SmartReading` 仍因 IDE 未注册该目录而重复失败，随后退化为大范围 PowerShell 搜索并被取消的问题。新增按 Cascade 会话隔离的工作区工具熔断器：从真实 assistant tool call 与对应 tool error 配对识别中英文工作区边界错误；确认失败后，下一轮从最终上游工具集合同时移除 `CodeSearch/code_search/SmartReading/smart_reading`，保留 `Read/Grep/FindByName/ListDir/run_command/trajectory_search`，并注入稳定、幂等的绝对路径降级指令。新对话不继承状态，显式项目根目录变化时自动复位。②实机用量日志确认“继续”后偶发 0 缓存时 `prompt_cache_key/system/tools` 指纹均未变化，部分属于第三方缓存分片冷未命中；同时发现客户端会在消息数增加时重写/摘要早期历史，令真实消息前缀失效。新增同一 Cascade 的最近上游历史镜像与尾部重合续接：仅在新旧历史存在至少两条确定性连续重合时保留上一轮逐字节前缀并追加新消息；无重合的分支/新任务不拼接，超过高水位仍交由既有检查点压缩。③编辑/写入工具新增必填参数契约，并在流式出口按 LSP schema 校验 `Edit/multi_edit/Write`；缺文件路径或编辑负载时不再把坏调用交给编辑器，而是在代理内回填结构化参数错误并透明重试，修正后才发送 LSP。④缓存观测新增完整消息指纹、停止原因、响应工具数与文本字节，今后可区分“上游冷未命中”“客户端历史重写”和“工具调用正常停顿”。新增工作区策略 32 项、真实路由历史续接、无重合分支保护及缺参编辑自动修复回归；核心闭环 347/347，其他上下文/缓存/自定义模型/四协议/反代/启动锚定/UI 回归全部通过。

v9.9.374 · Claude Code 风格的自定义模型执行内核：①大型工具结果超过 8K 字符时完整写入用户目录 `tool-output-cache`，上游上下文只保留确定性 `dao-output://` 引用与首尾预览；新增代理内工具 `dao_read_tool_output` 按 offset 分块回读，全文不丢失，缓存按 7 天/512 文件/256MB 有界回收。②MCP 工具 schema 超过模型上下文 10% 时自动延迟，核心读写/编辑/终端工具始终保留；新增 `dao_tool_search` 按能力搜索并激活匹配 MCP 工具，代理内部重试后仅把所需 schema 加入下一轮，同会话保持激活集合，避免 82 个工具同时稀释注意力与浪费缓存。工具预选已前移到上下文预算之前，延迟 schema 不再虚增 token 并误触发压缩。③压缩检查点显式保留计划/实施模式、最新 Todo、运行中命令状态和大输出引用。④Anthropic Claude 4.6+ 改发 `thinking:{type:"adaptive"}` + `output_config.effort`，4.5 及更早版本继续使用 `budget_tokens`，避免新旧协议错配 400。新增大输出完整还原、确定性引用、MCP 延迟/搜索/内部重试、预算顺序和 adaptive thinking 全链路回归。

v9.9.373 · 自定义模型调用策略重构（参考 Codex/OpenCode）：修复预算器只统计裁剪却仍把 118K–152K 完整历史发送给上游、造成注意力稀释和工具结果返回后长时间推理的根因。新增 Cascade 会话级高低水位状态机：默认在上下文 78% 触发里程碑压缩、落到 50%，保护约 40K 近期工作集，旧工具输出按 2K 字符归约，assistant/tool 原子配对不拆分；检查点锚定后仅追加新消息，直到下一次越过高水位才更新，兼顾模型质量与缓存前缀稳定。自定义模型追加结果导向执行契约：读工具仅在独立时并行，终端命令单实例，已有 exit code/最终输出即结束，仅明确返回 running+session id 时允许一次 `command_status`。GPT-5.6 Chat Completions+工具自动使用兼容的 `reasoning_effort=none`，Responses 保留用户思考强度；上游不接受 reasoning 字段时透明去参重试。新增 150K 长会话压缩、检查点逐字节复用、工具配对、终端契约与协议思考分流回归。

v9.9.372 · 缓存连续性与工具回合故障切换：实机账单记录确认“首字不适用”对应 0 秒失败请求 `HTTP 403 · Insufficient account balance`，不是流式首字解析丢失；该失败恰好位于连续工具回合之间，使上一轮新增的 assistant/tool 后缀无法进入上游缓存，下一轮只能命中更早的约 34K 前缀。路由器现在按错误类型熔断：余额/鉴权按渠道熔断，模型权限/不存在按模型熔断，429 尊重 `Retry-After`，网络与 5xx 短熔断；主渠道失败后自动选择“支持同一真实模型”的健康渠道，并按 Cascade 会话保持两小时粘性，后续工具回合不再反复撞坏渠道或随机漂移缓存分片。缺少 Cascade ID 时以“模型 + 首条用户消息”生成稳定脱敏缓存键，仍维持 Keep-Alive 单连接亲和。语义搜索类工具追加工作区边界说明：IDE 未注册绝对路径时改用 Read/Grep/FindByName/ListDir，避免把工作区工具拒绝误判成模型工具调用失败。新增缓存键、余额熔断、同模型备用、会话粘性和熔断排除回归。

v9.9.371 · ACP 团队设置本地真缓存兜底：修复主 `devin-cli` ACP 已正确连接本地代理，但官方 `GetCliTeamSettings` 偶发超过 Devin 固定 3 秒鉴权上限，导致 `Authentication failed: Team settings refresh timed out after 3000ms` 并继续显示 `Connecting to server…`。代理现在读取 Devin 自己保存的真实 `team_settings.bin` 裸 protobuf，在七天新鲜期内按 Connect unary 协议毫秒级返回；缓存缺失、无效或过期时仍透明直透官方。不是空 gRPC 伪响应，不会再触发 `invalid tag value: 0`，并新增新鲜/过期/非法缓存回归。

v9.9.370 · 模型解锁自愈启动宽限：修复 `ensureUnlockFlowing()` 在 language server 刚被 spawn、尚未完成握手且改写统计尚未稳定时，误判“LS 未经过代理”并立即 `forceRestartLS` 的第三处启动竞态。现记录最近一次 LS spawn 时间，启动或重连后 90 秒内绝不杀进程；大型工作区冷启动可自然完成。超过宽限且仍无改写/无 GetUserStatus 时才保留一次性自愈。与 v9.9.368 的精确卸载判定、v9.9.369 的写锚不重启共同闭合重启连接链路。

v9.9.369 · 启动期语言服务竞态根治：修复普通启动时延迟 `setAnchor()` 写入设置后无条件触发 `_maybeRestartLS()`，直接 `taskkill` 尚未完成握手的 language server，造成 `Language server exited before sending start data`，随后 Devin 状态机长期报 `Already waiting for language server start`。锚点写入现在默认不重启 LS；启动阶段依靠已安装的 spawn hook 让当前 LS 自然连接本地反代，仅 watchdog 检测到端口漂移或代理复活时才显式重启。新增启动锚点回归，确保后续修改不会重新引入“写锚即杀 LS”。

v9.9.368 · 重启连接竞态修复：修复升级安装后 `.obsolete` 仍保留旧版本目录时，当前版本在普通 Reload/关闭窗口过程中被误判为“正在卸载”，进而清除 API 锚点、端口状态与系统级残留，导致下次启动语言服务出现 `Language server exited before sending start data` / `Already waiting for language server start` 并长期显示 `Connecting to server…`。卸载侦测现在只接受当前扩展目录的精确标记；旧版本待删除记录仅视为正常升级清理。新增卸载判定回归，覆盖旧版本残留、当前版本真卸载、正常关闭和扩展注册缺失四种场景。

v9.9.367 · 新版 Devin 自定义模型目录注入
: 修复 Devin 1.110+ `GetUserStatus field20` 新目录结构只解锁已有模型、未注入⑦自定义模型的问题。新版分支现沿 `top.f1 → f33 → repeated f1` 克隆真实模型项，替换 UID/显示名/家族，统一补 `field20=1` 后返回；保存自定义模型后自动执行 `devin.restartLanguageServer`（兼容 Windsurf 命令并以 Reload Window 兜底），使右侧模型选择器重新获取目录。新增合成 protobuf 回归，验证 `dao` 被注入且所有模型可用。

v9.9.366 · 自定义模型旧会话权限回落修复
: 修复删除自定义模型后，Devin 已打开会话仍携带旧 modelUid 时请求回落官方上游并报 `Permission denied: an internal error occurred`。删除现在只从⑦目录及②③④⑥可见配置中移除模型，同时持久化一条隐藏兼容路由继续指向原渠道；旧会话、Reload Window 与恢复会话仍可正常调用，重新添加同 UID 会自动覆盖大小写双路由，避免 `MODEL_*` 别名残留旧配置。实机根因由捕获帧确认：当前帧仍为已清理的 `dao-smoke-*`，而路由已不存在。

v9.9.364 · ⑦界面重构与能力接口贯通
: ⑦自定义模型按⑥协议中转站同款 `pb-scroll/pb-card/pb-grid` 重构为“模型身份与上游 / 模型能力与 Devin 行为 / 已注册模型”三张卡片，改善窄面板与高分辨率布局。上游模型由 datalist 改为真正的渠道模型下拉框，提供“手动输入其他模型”和“重新探测渠道模型”兜底，消除白色悬浮建议框与选择错位。根治思考强度恒报 400：`dao_router.js` 已实现自定义模型能力接口，但 `runtime.js` 漏导出 `hotListCustomModels/hotGetModelCapability/hotUpsertCustomModel/hotRemoveCustomModel/hotCustomModelCatalog`，导致源站统一回 `runtime not loaded`；现补齐完整透传并加入 runtime 层回归。前端 HTTP 错误改为显示后端真实 error，不再只显示 `http 400`。同时修复“探取能力后立即保存”两个异步原子写竞争、旧快照可能覆盖新模型的持久化竞态，改为小配置同步写临时文件后原子 rename；引用保护仅对⑦手工加入渠道的上游模型生效，复用②已有模型时不再被其他同上游路由误阻止删除。

v9.9.363 · 均衡上游缓存亲和
: 实机日志确认同一 SVN 长任务的连续 `command_status` 请求始终保持相同 `prompt_cache_key`、system 指纹与 44 个工具定义指纹，但“gpt均衡”上游仍在 0% 与 93%–96% 缓存命中间交替，并伴随 503 后重试，根因是每次新建 TCP/TLS 连接后被均衡到不同缓存分片/账号，而非工具调用破坏前缀。新增按 Cascade 会话与上游 origin 隔离的 Keep-Alive 连接亲和池：同一缓存键固定复用单连接，不同会话隔离，连接池 LRU 上限 64；系统代理隧道也启用 Keep-Alive。保留稳定 `prompt_cache_key`，并新增亲和诊断与 TCP 复用回归。上游若主动关闭连接或在应用层强制随机账号仍可能冷命中，但客户端侧已采用最大化稳定策略。

v9.9.362 · ⑦自定义模型与全链路思考强度
: 新增与原六模块并列的“⑦ 自定义模型”：可增删 Devin 模型 UID、选择②已有渠道与真实上游模型，并自动探取/推断模型可用思考档位、上下文、输出 Token、图片及工具调用能力。保存后同步②渠道目录、③模型路由、Devin 模型目录、④模型反代和⑥协议中转；删除时保护其他路由与中转引用。③路由、④真实请求自测、⑥中转档案均改为能力驱动的思考强度下拉，自动映射 OpenAI reasoning effort、Responses reasoning、Anthropic/Gemini thinking budget，并修复客户端显式关闭思考仍被路由默认值重新开启的边界。新增自定义模型持久化、四协议工具 schema/MCP 工具名、DeepSeek thinking/tool_choice 风险、Webview 求值后语法及跨模块同步回归。

v9.9.361 · 协议转换测试台与六客户端配置
: ⑥协议中转站新增与④模型反代同源的真实转换测试台：可选择中转档案和目标协议，分别测试 OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini GenerateContent，或一键执行档案全部协议；结果同时验证 HTTP 状态、协议响应结构、回复文本和原始回包。新增 Codex、Claude Code、OpenCode、MiMoCode、OpenClaw、Hermes 六类可复制客户端配置，自动填入当前对外 Base URL、API Key、模型别名，并提示档案是否已启用客户端所需协议。修复首次加载时访问配置与档案异步竞争、补齐按钮/下拉/复制事件，列表测试统一进入新测试台。回归新增“同一个中转档案四协议均可转换”和“未勾选协议仍被拒绝”，并通过 Webview、CORS 四协议、协议桥、模型反代及快速总检 303/303。

v9.9.360 · 协议中转渠道能力联动与对外接入卡
: ⑥协议中转站复用②渠道 `/models` 自动探测：选择已有渠道后自动刷新模型目录与 `supported_endpoint_types`，将“上游真实协议”和“上游真实模型”改为联动下拉框；无模型目录或探测失败时保留手动模型输入兜底。渠道配置持久化 `supportedProtocols`，中转路由保存 `sourceProtocol`，模型反代优先采用路由协议，避免多协议渠道被默认协议覆盖。⑥新增独立对外接入卡，显示反代启用状态、Base URL、完整 API Key、显隐/复制按钮，以及 Chat、Responses、Anthropic、Gemini 四种接口；Gemini 地址随当前对外模型别名实时更新。

v9.9.359 · Webview 四协议网络链路修复
: 根治④模型反代与⑥协议中转测试统一报 `Failed to fetch`：面板请求携带 `x-goog-api-key`，旧 CORS 预检却只允许 `Content-Type, Authorization, x-api-key`，浏览器因此在请求进入模型前直接拦截。现按浏览器实际 `Access-Control-Request-Headers` 动态回显允许头，补 Private Network Access 与预检缓存；同时修复 `/v1beta/` 在主入口已识别、内部 `_maybeRevproxy` 却再次排除的 Gemini 分发缺口。新增 Chat、Responses、Anthropic、Gemini 四协议 Webview 预检回归测试。

v9.9.358 · 面板导航加载卡死修复
: 修复⑥协议中转站测试结果字符串在 Webview 模板求值后产生裸换行，导致整段内联脚本语法错误、六个导航按钮全部失效且页面永久停留“加载中”的问题。新增宿主侧 Webview 脚本语法预检与独立回归测试；今后同类模板转义错误会在打包前失败，运行时也会显示明确错误页而非无提示卡死。

v9.9.357 · 独立协议中转站·三页面原子同步
: 参考 VibeAround Model Profile + API Bridge 结构新增“⑥ 协议中转站”。可复用②已有渠道，或填写 Base URL/API Key 新建托管渠道；为 DeepSeek、MiMo 等 Chat-only 模型设置上游真实协议、真实模型、对外模型别名和允许输出协议。保存时同步创建/更新② provider 与③ route，并以 `_bridgeManaged/_bridgeId` 标记；②显示“协议中转”托管渠道，③显示中转同步映射，④模型反代按对外别名提供 Responses、Chat、Anthropic、Gemini 接口，⑥集中显示同步状态、端点并可直接测试。目标协议实行真实权限闸门，未勾选协议返回 `protocol_not_enabled`。档案独立持久化到 `~/.codeium/dao-byok/protocol-bridges.json`，不重复保存 API Key；删除档案会同步清理托管 provider 与 route。

v9.9.356 · VibeAround 四协议本地中转
: 模型反代扩展为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini Generate Content 四协议统一入口，新增 `/v1/responses`、`/v1beta/models/{model}:generateContent`、`streamGenerateContent` 与 Gemini 模型枚举。复用既有鉴权、模型路由、双路故障切换、用量记账和公网隧道，不新增第二套代理。修正 Responses 适配器“已声明但未参与真实出站”的缺口，新增 Gemini 原生适配、`x-goog-api-key`、非 SSE JSON 兜底、工具调用跨协议透传及缓存 token 用量输出。模型反代 UI 改为单协议卡片切换，自测可选四协议；渠道配置新增显式协议选择。专用回归新增四协议、模型枚举和工具调用验证。

v9.9.355 · 项目提示词独占替换
: 项目提示词注入改为严格全替换：选中项目后，模型 system prompt 仅保留该项目文本，不再追加默认经藏、官方系统提示词、工具保留块或工作区实时块。项目库统一关闭 keepBlocks，旧项目注入时自动按新语义生效。本源观照默认只展示模型实际收到的 system prompt 及其字数，不再把对话历史、工具定义等全请求字段展开成 20 万字以上的混合文本；完整上游诊断数据仍保留在 `/origin/upstream` 接口。

v9.9.354 · 缓存命中观测与工具历史配对修复
: `/origin/ea/usage` 新增最近 5 次命中率与最多 20 条脱敏逐请求明细，仅记录 input/cached、会话键哈希、system/tools 指纹和消息数量，不落提示词正文或密钥；渠道面板区分累计与近期命中率。修正预算器反向遍历误把合法 `assistant(tool_calls) → tool(result)` 结果判为孤儿的统计缺陷，按完整工具调用单元原子保留或裁剪。新增缓存窗口、脱敏指纹及工具配对回归。

> 完整版本历史。详情页（README）保持精简，本文件单列于扩展的 Changelog 标签页。

v9.9.354 · 项目提示词库·一键注入 Devin
: 新增本机 `/origin/prompt-studio` HTML 管理页，提示词可按项目名称、分类和项目路径保存；
  项目库持久化到 `~/.codeium/dao-byok/project-prompts.json`，插件升级后仍保留。支持新建、
  编辑、搜索、删除、恢复默认，以及“保存并注入/直接注入”。注入时写入真实 `/origin/custom_sp`
  链路并自动切换 `invert`，下一条 Devin/Cascade 对话立即采用选中项目提示词；可选择是否保留
  Devin 工具调用和工作区必要上下文。新增命令“道Agent Pro: 项目提示词注入”。项目库接口与
  页面限制为本机访问，防公网隧道意外暴露。新增隔离持久化/切换注入测试，并经内置浏览器验证
  分类渲染、项目切换、注入反馈与宽屏布局。

v9.9.353 · 官方直通 502 根治·收官(stale 优先于配额·实证反代真通)
: 承接 v9.9.352——实机(Devin Desktop · 免费 SWE-1.6 Slow)复现暴露残缺: 官方以 Connect
  `code=failed_precondition` 回陈旧会话错, 而旧 `exhausted` 启发式含 `precondition` 关键字
  → 陈旧会话被**误吞为配额耗尽**(既不失效陈旧帧、又误置 `premiumQuota=exhausted`; stale 分支
  受 `!exhausted` 守卫从不执行) → 死锁重演。正法: 提取纯函数 `_classifyOfficialErr(txt)` 确立
  优先级契约「会话失活/版本过旧 > 配额耗尽」, HTTP≥400 与 Connect end-stream 两分支同序判定;
  stale 命中即失效陈旧帧 + 回明确重采指引(不误置配额)。新增 [20] 回归: precondition 编码的
  陈旧会话判 stale 不判 exhausted、真配额 precondition 仍判 exhausted 不误判 stale。
  实证闭环: 新鲜捕获帧下经反代调免费 `swe-1-6-slow` —— OpenAI unary 5/5 HTTP200、SSE 流式
  增量+`[DONE]`、Anthropic `/v1/messages` 200(官方反代真通); 帧陈旧(约 1min)即 424
  `stale_session` 自动失效重采。守正: 绝不伪造客户端版本号。
  安全收官(邦利器不可以视人): 实机审计发现 `GET /origin/{ea,revproxy}/handoff.md` 无鉴权、
  且文中内嵌本机 `apiKey` + 公网隧道 URL —— 隧道活时任何知公网 URL 者 GET 即读走 key、
  彻底架空 apiKey 防护(数据面 `/v1/*` 已正确 401, 唯交接文档漏防)。正法: 新增 `_handoffGuard`
  与数据面同鉴权模型—本机(loopback·无 cf/转发头)零配置可读, 公网(隧道转发)/非本机必须持
  有效 Bearer key(持钥者本已知 key·返回无害); 两文档端点同守。新增 [21] 回归 5 例:
  本机放行 / 公网无 key 被 401 且响应不含真 key / 公网持有效 key 放行 / 公网错 key 被 401。
  缓存命中根治补充: 实机请求证明 Cascade 将工具结果编码为 `role=user` 但同时携带
  `tool_call_id/tool_result_is_error`;旧 `_buildOAMessages` 仅认 `role=tool`，遂丢真实配对并由
  `_fixOAMessages` 为每次调用伪造 `[tool result for ...]`，工具失败时再叠两条 user 错误文本，
  令外接网关难以稳定复用历史前缀。本版按 `tool_call_id` 归一真实 tool result、保留错误标记，
  不再伪造已有结果；OpenAI-compatible GPT/Responses 路由以 Cascade 会话 ID 发送稳定
  `prompt_cache_key`，上游若明确不支持则透明重试并记忆降级。新增 L4.5 回归覆盖真实 Cascade
  形态、无占位结果、Chat/Responses 缓存键与不兼容降级。复审再收口三处边界：缓存键只取
  稳定 `cascadeId`（不以可能逐轮变化的 `promptId` 兜底）、真实工具结果可直接作为续跑请求
  末项（不再插空 `assistant`）、JSON 请求亦保留 `tool_result_is_error`。诊断转储新增 system/tools
  指纹与实际缓存键，便于实机逐轮确认公共前缀稳定。

v9.9.352 · 根治官方直通 502 · 陈旧会话/版本失配自愈(反者道之动·没身不殆)
: 承接实机 502 排查——经模型反代调官方直通(免费 SWE-1.6 等)时上游回
  `There was an error with your Cascade session, please update your editor`,
  旧实现把它当普通 `upstream_error` 502(暗示网关瞬时故障) → 客户端对同一**陈旧捕获帧**
  无限重试、盘存坏帧从不失效 → 回环永久卡死, 唯有用户手动再发一条 Cascade 对话才解。
  三十九章「其致之也·侯王毋已贵以高将恐蹶」: 帧之贵在其活, 死帧当弃。本版:
  ① `source.js` 增 `_isStaleSessionErr()` 精准识别「会话失活/客户端版本过旧」拒绝
     (regex 收紧·不误伤配额/普通故障);
  ② 增 `_invalidateStaleFrames()`: 命中即失效内存主/免费槽 + 删盘存帧文件
     (`chatframe(.free).bin/.json`) + 弃陈旧鉴权信封 → 下次 IDE 活跃(补全/对话)自然
     重采新鲜帧, 回环自愈(不再狂重试同一坏帧);
  ③ `_officialChatReplay` 两处错误分支(HTTP≥400 与 Connect end-stream)接入: 换主槽
     兜底重试仍败且判定陈旧 → 失效坏帧 + 回明确可执行指引(而非生吞上游原文);
  ④ `revproxy.js` `_classifyUpstreamError` 把会话失活/版本过旧归为 **424 Failed
     Dependency + `code=stale_session`**(先决条件缺失·非瞬时故障) → 客户端据此停重试
     并按指引重采, 而非盲目退避。
  守正不伪: 绝不伪造/篡改客户端版本号绕过官方版本门槛(欺骗且危账号)——只失效坏帧、
  引导以「当前真实运行的 IDE」重采真实鉴权信封。自检新增 [20] 覆盖归类与失效自愈。

v9.9.351 · 模型反代用量记账归一 · 反代调用亦入「用量与成本」
: 实机验证(DeepSeek/小米 Mimo 双渠道直连+路由+反代全链路)时发现: 经模型反代
  `/v1/chat/completions`(OpenAI 兼容)与 `/v1/messages`(Anthropic 兼容)调用第三方渠道,
  tokens 消耗**不入**面板「用量与成本」(`/origin/ea/usage` 恒空)——用量聚合仅覆盖 Cascade
  路由路径(`dao_router.route()` 内 `_recordUsage`), 反代路径旁路了记账。四十四章
  「知足不辱 知止不殆」: 知其所耗, 方知所止。本版:
  ① `dao_router.js` 导出 `recordUsage`(外部记账入口·与 Cascade 路径共用同一张
     `_usage` 表·同享缓存命中率/成本估算);
  ② `runtime.js` 增 `routerRecordUsage()` 透传;
  ③ `source.js` `_revproxyDeps()` 注入 `recordUsage` 依赖;
  ④ `revproxy.js` `_bridge()` 在 onUsage 处按渠道/模型记账(仅第三方渠道目标·
     builtin-stub/官方直通不计·流式与 unary 皆覆盖)。
  实测: 反代双协议调用后 `/origin/ea/usage` 正确出账(deepseek 与 xiaomi-mimo 各自
  calls/input/output/cached/hitRate 齐全)。

v9.9.350 · 根治「添加失败: runtime not loaded」· 健壮解析外接api目录 + ea/* 惰性自愈
: 承接用户端反馈「加渠道即报 runtime not loaded」——排查确认开发机运行时正常(路由就绪·25模型),
  故为**安装/环境特定失败**。根因: `source.js`/`extension.js` 硬编码中文目录名「外接api」(非 ASCII),
  在 VSIX(zip) 打包/解包时非 ASCII 目录名编码不稳, 部分用户机上目录名被搞坏(mojibake) →
  `fs.existsSync(...外接api/runtime.js)` 恒 false → `_eaRuntimeMod` 永为 null → 加渠道即
  「添加失败: runtime not loaded」。本版:
  ① **健壮目录解析**: 新增 `_resolveEaDir()`/`_eaRuntimePath()`/`_eaRouterPath()`(source.js)与
     `_resolveEaRuntimePath()`(extension.js) —— 先试规范中文名, 找不到即按内容扫描 vendor/ 下
     「含 runtime.js + core/dao_router.js」的子目录, **名字坏掉也能凭内容命中**。全部硬编码
     「外接api」路径(初载/热重载/缓存清理)改走解析器。
  ② **ea/* 惰性自愈**: 新增 `_ensureEaRuntimeMod()`, 任何 `/origin/ea/*` 请求进入前先试按需补载
     runtime(require 缓存命中即秒返), 不再一遇 null 就直接抛「runtime not loaded」· 反者道之动。


v9.9.351 · 发布包补齐全部运行时文件 · 「runtime not loaded」终章
: 实锤真源: 发布页 9.9.347 VSIX **不含 vendor/外接api/runtime.js** —— `runtime.js`/`cascade_wire.js`/
  `sp_core.js`/`resilience.js` 等 39 个运行时文件与 `vendor/bundled-origin/` 全套从未提交入仓,
  打出的安装包天生残缺, 装谁谁报「runtime not loaded」。本版: ① plugins/ 补齐 39 个缺失文件;
  ② packages/(CI 打包源)补齐 bundled-origin 全套 23 文件并字节对齐本源 devin-remote v9.9.350;
  ③ 干净克隆重打包并闭环实测: 解包直启 origin → 添加 DeepSeek/小米MiMo 真实渠道 ok → 模型自动
  发现 → 探活 200 真实补全。渠道配置存于 `~/.codeium/dao-byok/配置.json`, 升级/重装不丢。

v9.9.350 · 根治「添加失败: runtime not loaded」· 健壮解析外接api目录 + ea/* 惰性自愈
: 承接用户端反馈「加渠道即报 runtime not loaded」——排查确认开发机运行时正常(路由就绪·25模型),
  故为**安装/环境特定失败**。根因: `source.js`/`extension.js` 硬编码中文目录名「外接api」(非 ASCII),
  在 VSIX(zip) 打包/解包时非 ASCII 目录名编码不稳, 部分用户机上目录名被搞坏(mojibake) →
  `fs.existsSync(...外接api/runtime.js)` 恒 false → `_eaRuntimeMod` 永为 null → 加渠道即
  「添加失败: runtime not loaded」。本版:
  ① **健壮目录解析**: 新增 `_resolveEaDir()`/`_eaRuntimePath()`/`_eaRouterPath()`(source.js)与
     `_resolveEaRuntimePath()`(extension.js) —— 先试规范中文名, 找不到即按内容扫描 vendor/ 下
     「含 runtime.js + core/dao_router.js」的子目录, **名字坏掉也能凭内容命中**。全部硬编码
     「外接api」路径(初载/热重载/缓存清理)改走解析器。
  ② **ea/* 惰性自愈**: 新增 `_ensureEaRuntimeMod()`, 任何 `/origin/ea/*` 请求进入前先试按需补载
     runtime(require 缓存命中即秒返), 不再一遇 null 就直接抛「runtime not loaded」· 反者道之动。

v9.9.347 · 内网穿透对齐二合一本源 · 激活即自动连接 + 模型反代专属交接文档
: 承接用户实证「Proxy Pro 内网穿透整体没跑通·甚至没自动连接好」——本源(dao-vsix 二合一)的公网穿透
  是开机即自动打通的去中心化通道, 而 Proxy Pro 仅在用户已绑 CF API Token 时才自动拉起固定中继,
  **零账号快速隧道从不自动起**, 用户须手点「启动隧道」→ 表象即「没有自动连接好」。本版补齐:
  ① **激活自动连接(`_brgAutoConnect`)**: `server.on("listening")` 延迟 6s(待反代就绪)自动打通公网,
     优先级「善用者不弃物」= 已绑 workers.dev 固定中继(持久·永不轮换)> 已存命名隧道令牌(固定域名)
     > **零账号快速隧道(去中心化默认·无需任何账号)**; 缺 cloudflared 二进制后台 6 路镜像拉取, 就绪后
     watchdog 自起(不阻塞激活)。实测激活 <5s 即得 `*.trycloudflare.com` 公网URL。
  ② **手动停止即真停(`_BRG_USERSTOP` 旗·移植 dao-vsix `bridgeUserStopped`)**: 用户点「停止」落盘暂停旗,
     自动连接/自愈见旗即挂起(尊重用户意志); 任一手动「启动/重启」撤旗恢复常驻; 24h 安全自复防遗忘致
     公网端点永久断线。`_brgStartTunnel(named, manual)` / `_brgStopTunnel(manual)` 新增 manual 形参贯通。
  ③ **模型反代专属 Agent 交接文档 `GET /origin/revproxy/handoff.md`**: 与总交接文档 `/origin/ea/handoff.md`
     分工, 专注「模型反代 → 内网穿透 → 公网第三方无感直调」这一条链路的接管。实时含: 当前状态表
     (反代开关/可反带模型数/本地Base/Key/隧道状态/公网Base/持久中继)、公网直调 curl+Python 范例
     (换 Base 不换 Key)、三条开通/自愈路(零账号快速隧道 / 一个 CF API Token 零域名固定中继 / 命名隧道)、
     热管理 API、自愈要点。④「模型反代」面板底部新增「📄 Agent 交接文档 · 模型反代→公网直调」区
     (复制/下载/预览), 与②「渠道配置」面板底部的总交接文档并列。
  ④ endpoint.json 的 `revproxy` 段增 `handoff_url`; ⑤ 面板顶部文案标注「激活即自动连接·断线 15s 自愈·
     手动停止后点启动/重启恢复」。道义: 三十七章「道常无为而无不为」· 无为=用户零操作, 无不为=公网恒通。

v9.9.346 · 捆绑 ACP 代理 · 实证收口(DESKTOP-MASTER 现场日志驱动)
: 承 v9.9.345 把捆绑 ACP 代理(chisel)的 `WINDSURF_API_SERVER_URL` 锚向本地反代后, 现场实测
  (controlled spawn·`devin.exe acp` 注入 env)暴露两处收口点, 本版补齐:
  ① **`GetCliTeamSettings` 归 PASSTHROUGH(修 Connect 解码 `invalid tag value: 0`)**: 该 RPC 原
  命中 v9.9.344 的 `LOCAL_AUTH` 短路 → `_replyGrpcOk` 回的是 **gRPC 帧**(5 字节前缀·首字节 0x00
  压缩位)。LS 走 gRPC 只验 `grpc-status` 故无碍; 但 chisel 走 **Connect** 协议按 unary(裸
  protobuf·无帧前缀)解 payload → 首字节 0x00 被当作 field tag 0 →
  `Connect decode error: Protobuf decode error: invalid tag value: 0` → `Failed to fetch team
  settings`。解: 把 `GetCliTeamSettings` 并入 `SEATMGMT_PASSTHROUGH_METHODS`(与 `GetUserStatus`
  同), 由真端(self-serve)按客户端协议正确成帧回**真 TeamSettings** → chisel 解码必过; 官方不可达
  时 chisel 自有磁盘缓存兜底(实测 0ms `Team settings loaded from cache`)→ 仍不卡。
  ② **`dao-acp-stdio-proxy.js` 永久版·健康门控自注入**: v9.9.345 的 env 注入在 `extension.js`
  spawn-hook, 仅新装 ≥v9.9.345 生效; 用户机现装 **v9.9.334** 无此逻辑。故把「反代健康→锚定
  `WINDSURF_API_SERVER_URL`+`NO_PROXY`」下沉进 stdio 中间人: spawn 前探本地反代 `/origin/ping`,
  200 才注入(与 `_proxyHealthy` 同源门控·失败安全直连官方); stdin 探测期间缓冲保序回放。中间人
  每次 spawn 重读本文件 → **已装 v9.9.334 基座无需 reload/重装即刻生效**。若上游 spawn-hook 已锚则
  不覆写(分工不重)。实证: 注入后 `Model registry fetched from API in 906ms`(经反代出站)·team
  settings 不再 3s 超时·`authenticate` 正常受理·无「Connecting to server」。
  道义: 五十二章「天下有始 以为天下母 · 既得其母 以知其子」· 母=本地兜底 · 子=鉴权态。

v9.9.345 · 捆绑 ACP 代理(devin.exe/chisel)鉴权本地锚定 · 根治「Connecting to server」残余
: 病(根因·实证于 DESKTOP-MASTER exthost/ACP 日志): v9.9.344 已把 LS(language_server)的
  `--api_server_url`/`--inference_api_server_url` 反代至本地 8937, 但 IDE 另起的**捆绑 ACP 代理**
  (`devin.exe acp --agent-type summarizer`, 即 chisel · 自持 windsurf_api_client)**漏网**——它绕开
  8937, 经系统 VPN 直连 `WINDSURF_API_SERVER_URL`(默认 server.codeium.com)取 `GetCliTeamSettings`
  做启动鉴权。官方经系统代理偶发 >3s 即 `Team settings refresh timed out after 3000ms` →
  `Failed to authenticate bundled agent` → 前端永卡「Connecting to server」(与官方可达性强耦合·
  VPN 抖动即复发, 故 v9.9.344 后台式机仍偶现)。
  治(既得其母 以知其子): `installSpawnHook` 拦截 devin.exe(ACP)时, 反代健康即注入
  `WINDSURF_API_SERVER_URL=http://127.0.0.1:<反代口>`(经 stdio 中间人 `env:process.env` 透传至
  devin.exe), 并把 `127.0.0.1,localhost,::1` 纳入 `NO_PROXY`(本地反代走明文 h2c·须绕开系统 VPN 代理,
  否则 127.0.0.1 被兜转致连不上)。于是 `GetCliTeamSettings` 命中反代→即刻本地 gRPC OK(实测 ~75ms)·
  无 3s 超时·鉴权必过·与官方可达性彻底解耦; `GetUserStatus`/`GetCliModelConfigs` 经反代 PASSTHROUGH
  取真数据(官方可达时)。新增 `_acpEnvAnchorApi(env)` 复用于 spawn/spawnSync/execFile 三处。
  fail-safe: 仅 `_proxyHealthy` 时改写(与 `maybeRewriteLsArgs` 同源门控)·否则原样直连官方·
  "至少和没装插件一样能用"。道义: 五十二章「天下有始 以为天下母 · 既得其母 以知其子」。

v9.9.344 · 座席鉴权本地兜底 · 根治「Connecting to server」(釜底抽薪)
: 病(根因): LS 启动后周期调 SeatManagement/GetUser 座席鉴权 + Heartbeat 心跳。
  SeatManagement 非 API_SERVER/INFERENCE → 默认归 PASSTHROUGH 路由至 UPSTREAM_MGMT
  (server.self-serve.windsurf.com), 该端不实现此 RPC → 404/连接断; 同理 Heartbeat
  走 server.codeium.com。官方 H2/gRPC 长连一旦在本网络被切断(与 cloudflared/relay 同症),
  座席鉴权即不可达 → LS 判定「未鉴权」→ GetUserSettings 空 → 前端永卡「Connecting to server」。
  治(反者道之动·釜底抽薪): 新增 `LOCAL_AUTH` 分类 —— `LOCAL_AUTH_SERVICES`(SeatManagementService)
  与 `LOCAL_AUTH_METHODS`(Heartbeat)命中即本地直返空 gRPC OK(status=0), LS 只验 grpc-status
  即认「已连接」, 彻底解耦官方可达性。守真: `GetUserStatus` 仍走 PASSTHROUGH 经 proxyToCloud
  做真解锁改写(去 Pro 锁/补 field20); 模型目录仍由 GetUserSettings(MODEL_UNLOCK)注入;
  推理仍走 BYOK/INFER_STRIP → 本兜底不夺其真。新增 `_replyGrpcOk()` 本地 gRPC OK 应答器。

v9.9.343 · 根治 Windows 黑窗闪现(windowsHide 补齐)
: `_readSystemProxy()` 的 `reg query` execSync(经 cmd.exe)、独立版 `_brgProbeLocalProxy()`
  7 端口 `Test-NetConnection` spawnSync(一轮最多闪 7 个 powershell 窗)、`where cloudflared`
  execSync 均缺 `windowsHide:true` → 台式机经常性黑窗弹出。全部补齐并配 stdio 静默。

v9.9.342 · 内网穿透架构大修(移植 dao-bridge 核心) + ⑤ 面板归一折入复用共享隧道
: 独立版: 把 dao-bridge 底层完整移植入 source.js —— 代理检测(7 端口探活)+注入 cloudflared
  子进程、二进制 --version 验证、断点续传、CONNECT 代理隧道下载、多镜像回退(6 路)、看门狗
  (15s)、resetProxy API —— 使 Proxy Pro 单插件即可独立起隧道暴露反代端点公网, 且用独立
  命名空间(proxypro 8957 · cloudflared 独立)与 dao-vsix(9920)井水不犯河水。
  归一折入版(dao-one · foldBridge): ⑤ 内网穿透面板不再隐藏、五 tab 全出; 但公网穿透
  **复用**二合一本源「🌐 内网穿透 · DAO Bridge」的**同一条** cloudflared(道并行而不相悖·
  不重复造轮子)——`_brgReadSharedTunnel()` 读 dao-vsix 落盘连接文件(~/.dao/dao-conn-current.json
  等)取共享公网 URL; `_brgStatus(preferShared)` 于折入模式回显该 URL; `/origin/revproxy/tunnel`
  认 `?shared=1`。折入模式隐藏启停按钮(启停归顶部🌐板块)与 Cloudflare 命名隧道区, 只留「↻ 刷新」,
  下方状态/公网接入/自测实时映射共享隧道。

v9.9.341 · 视图 ID 归 daopp.* 命名空间(根治与归一内折 Proxy Pro 抢注视图)
: v9.9.340 并行修复只把命令归了 `daopp.*`，视图仍注册 `dao.essence`/`dao.router` —— 与
  dao-one 内折的 vendor-proxy 抢注同一视图, 后激活方直接 FATAL(`view already registered`),
  归一插件整体激活失败, 连带官方服务链路错位(连不上服务)。本版把视图 ID 一并归
  `daopp.essence`/`daopp.router`(package.json contributes 与 registerWebviewViewProvider 两处同步),
  独立版与归一内折版井水不犯河水。

v9.9.334 · 守真突破(活鉴权信封 · 脱「首次须用户发对话」之依赖 · 无为而无不为)
: v9.9.333 的会话鉴权保鲜仍以「最新捕获帧 `_lastChatFrame`」为唯一鉴权源, 而该帧只由
  CHAT_PROTO(GetChatMessage)捕获 → 持久帧 token 随会话轮换失活时, 仍须「用户再发一条
  Cascade 对话」铸新活 token(守真)。此即「首次/每次都要用户发消息」之限的根。
  正法(道法自然): 会话鉴权信封(顶层 field1·内含 `devin-session-token`)并非 chat 独有——
  IDE 一活跃(打开文件即触发的自动补全/上下文等 inference 请求)就向本 origin 发出携同一
  鉴权信封的请求。故新增 `_harvestAuthEnvelope(body)`: 从任一 inference 请求
  (CHAT_PROTO/CHAT_RAW/INFER_STRIP)采顶层 field1[+field16 cascadeId], 内容自证含会话标记
  (`session-token`/`devin-team$`/`devin-session`)才采信, 存 `_lastAuthEnvelope`(内存·随宿主生死·
  不落盘免持陈)。`_graftFreshSession` 改为在「活鉴权信封」与「最新捕获帧」间按 `at` 取更鲜者
  作鉴权源, 配合磁盘常驻骨架帧(形)嫁接 → 用户只需打开 Devin Desktop 正常用, 系统即自然
  采得活鉴权出包, 不待守真。`/origin/ping` 的 `authgraft.last_src` 标注本次嫁接鉴权源
  (`envelope`|`chatframe`)。宁稳勿崩: 非鉴权信封不动、全 try 兜底、序列化失败回退原体。

v9.9.333 · 会话鉴权保鲜(治「初始帧」失活 · 跨会话回放不再 unauthenticated)
: 用户实测反代免费模型恒返回「官方上游错误: an internal error occurred」。经把捕获帧原字节
  直发上游(server.codeium.com)复现, 得真错码 = `unauthenticated`(被上游掩码为
  "an internal error occurred")。根因: 鉴权令牌 `devin-session-token$<JWT{session_id}>`
  嵌于帧体顶层 field1(子消息 field1.3), 与 field16(cascadeId)为「会话钉定」的一对;
  捕获帧仅存该令牌、从不刷新。免费活水槽帧常捕于「上一会话」→其 token 随会话轮换失活,
  而主槽每轮皆被最新捕获帧覆盖(携当前活会话 token)。免费档回放取免费槽 → 带失活 token →
  上游 `unauthenticated`。此即上个对话遗留「初始帧」病之真因(非配额、非路由)。
- `source.js` 新增 `_graftFreshSession`(+ `_topFieldRaw`): 回放前, 若取用帧非最新捕获帧
  (如旧免费活水槽), 借「最新捕获帧」(`_lastChatFrame`·恒最鲜·携当前活会话)的 field1(鉴权
  子消息)+field16(cascadeId)整体嫁接到回放体 → 任一历史槽帧皆借最新活会话鉴权出包,
  跨会话回放不再失活。缺 field1 / 序列化失败则回退原体(宁稳勿崩)。
- 于 `_officialChatReplay` retarget 后、发包前施加; `/origin` 诊断新增 `authgraft`
  计数(rewrites>0 证嫁接生效·last_age_ms=所借最新帧新鲜度)。原汤化原食·活水恒足。

v9.9.332 · 反代提示词隔离(回归模型本源) + 模型外接选择
: 用户反馈反代端点回包错乱——上游模型自认 Cascade、回包混入插件语境。根因: 官方直通
  复用捕获帧时, 帧内仍携 Cascade 全量系统提示词(捕帧于注入前=原始官方 SP)。
- `source.js` 新增 `_isolateChatFrameSP`: 复用前剥净帧内 SP 载体(顶层裸文本字段 +
  数组内 role=0 条目两 schema 兼容·置空后不可解则回退原帧)。配置 `isolatePrompt`
  默认开(反代回包即模型本源·"Kimi 即 Kimi"), 关则透传旧行为。
- `revproxy.js` 模型外接选择: 新增 `disabledModels` 配置(默认空=全部反代);
  `/v1/models` 不列已排除模型、调用即 403 `model_not_exposed`;
  新增 `/origin/revproxy/models` 端点(单个/批量/setAll 热切·本机或持 key 远程可管)。
- `extension.js` 面板: 每模型/家族外接复选框 + 全选/全不外接 + 「提示词隔离」开关。
- 自检新增 [17] 提示词隔离 8 项 + [18] 模型外接选择 12 项(全过)·dao-test 328 回归全过。

v9.9.331 · 提示缓存从根修复(命中率≈0 → 真命中) + 面板缓存命中率观照
: 用户反馈外接 API 缓存命中率几乎为零。根因三重: ① Anthropic 仅 thinking 时才钉 system
  cache_control/发 prompt-caching beta 头,工具与对话历史从不钉断点 → 非 thinking 路径
  缓存归零、thinking 路径仅 system 小段可缓存; ② OpenAI 兼容流式请求不发
  `stream_options.include_usage` → 流式响应无 usage 块,DeepSeek 的 `prompt_cache_hit_tokens`
  字段亦未提取 → cached 永为 0(假零); ③ `_recordUsage` 只聚合 input/output,cached 丢弃,
  面板无从展示。
- `adapters.js` Anthropic: system 恒为 content-block 数组并钉 `cache_control:{type:"ephemeral"}`;
  末位工具钉断点(全部工具定义可缓存);新增 `_applyMessageCacheBreakpoint` 末条消息钉断点
  (下一轮整段历史成缓存前缀 · 逐轮递增命中);`anthropic-beta: prompt-caching-2024-07-31` 恒发。
  usage 增提 `cacheWrite`(cache_creation_input_tokens)。
- `adapters.js` OpenAI Chat: cached 提取兼容 DeepSeek `prompt_cache_hit_tokens`(流式+unary)。
- `dao_router.js`: 流式请求附 `stream_options:{include_usage:true}`(`provCfg.streamUsage=false` 可关);
  `_tokenCount`/`_recordUsage`/`usage()` 全链路聚合 cached+cacheWrite,按渠道/模型给出
  `hitRate`(%); unary 路径也回传 tokenCount(旧版 unary 用量从不记账)。
- `extension.js` 外接API面板: 渠道卡新增「◈ 缓存命中 x% · N tok · 写M」行,命中率绿/黄/红三色观照。
- 自检新增 L4.5「提示缓存」9 项断言(dao-test.js 全量 327 项全过)。

v9.9.330 · 治本 · 扩展↔LS 握手 wedge 自愈(从根解「连不上官方服务」反复复发)
: 真机根因定位:反代 :8937 健康、锚定亦在、预热帧已跨重启常驻(#937),但 Cascade 仍反复
卡「Connecting to server…」。真源**不是网络/配额/预热帧**,而是 codeium 扩展客户端的
**LS 状态机 wedge**——LS 进程 `exited before sending start data` 后管理器卡在
`Already waiting for language server start` 死循环、不再重启新 LS;旧看门狗只看
`/origin/ping` 健康 →「安心」早返,从不感知此 wedge,故复发不止。
- `source.js`:新增 **LS 心跳活性观照** `_lastLsReqAt`——仅在「真 LS→上游」请求(排除
  `/origin/*` 控制面与 `/v1/` 外接反代)时刷新;`/origin/ping` 暴露 `ls_last_req_at` +
  `ls_idle_s`。LS 活时每 ~5s 心跳、idle 恒低;wedge/死则 idle 持续增长 → 成 wedge 判据。
- `extension.js`:看门狗「安心」分支前置 `_maybeHealLsWedge(ping)`——`proxy 健康 + 锚定本口 +
  ls_idle_s≥90s` 即判扩展↔LS wedge → 执行 `windsurf.restartLanguageServer` 重置状态机
  (回落 kill LS 进程令其重生),带 90s 启动危窗 + 180s 冷却防风暴。**无为而无不为:机器自愈,
  无需人工重启语言服务器**。
- 新增自检 `_lswedge_selftest.js`(`npm run test:lswedge`):7 断言全过——控制面 ping 不算 LS
  心跳(idle 持续增长)、真 LS 流量刷新心跳戳(idle 归零)。

v9.9.326 · ④ 模型反代档位热切换(朴散则为器 · 家族归组 + 档位热切 + 别名直调)
: 把 Devin Desktop 的「选档」底层逻辑迁入 ④ 模型反代——同族多档(none/low/medium/high/xhigh/max,
+thinking/+fast)按**家族归组**呈现,行内一个**档位下拉**可热切该族「当前活跃档」,热生效无需重启。
- 后端 `revproxy.js` 新增家族·档位归一: `buildFamilyIndex`(从官方目录按 modelFamilyUid 归组)、
  `_familyActiveUid`(默认择档通用规则: **免费档优先** → 家族默认档 → 中档 → 首档·"免费即默认主力")、
  `familySummary`(每族活跃档 + 各档独立配额色)、`_resolveFamilyAlias`(干净家族名/familyUid → 当前活跃档)。
- 新增控制面 `POST /origin/revproxy/tier {familyUid,modelUid}` 热切档位落盘 `revproxy.json.tiers`;
  `/origin/revproxy/status` 回传 `families[]`+`tiers`;`/v1/models` 额外暴露**家族别名**(如 `gpt-5.4`)
  供外部以干净家族名调当前活跃档,显式档位 uid 仍精确直达不被改写。
- `resolveTarget` 前置家族别名解析: 外接客户端用 `glm-5.1` 即拿当前活跃档,`gpt-5-4-high` 仍精确指定。
- 前端 ④ 面板 `_rpRenderList` 重构为按家族归组: 多档族一行 family + 档位下拉(每档带 🟢/🔴/🟡 实时配额色),
  单档族保持原样;切档即 POST tier 热生效并刷新。图例增 `N族(M族多档可热切)`;一键自测下拉按家族 optgroup。
- 通用适配全部 16 个多档家族(GLM/GPT/Claude 各档),非仅 GLM;每档保留独立红绿配额色(非家族继承)。
- 自检 [13] 新增: 家族归组 + 默认择档 + 别名解析 + 热切生效 + 缺参 400,revproxy 自检扩至 45 断言全过。

v9.9.325 · 官方直通回包解码归一(配额信号真源 · Connect end-stream gzip 解)
: 修复 ④ 模型反代「官方直通」实测：捕获帧已能正确改写并真转上游(v9.9.324),但回包恒报
「官方回包解码为空」。真因：上游 Connect 流式回包的**收尾帧 = gzip 压缩的 end-stream 帧**
(flags bit0=compressed + bit1=end-stream, 载荷为 JSON `{}`/`{"error":{code,message}}`),旧解码把
gzip 字节直喂 `parseProto` 取串 → 必空;且 HTTP 200 也会在此帧内携带 quota 错误(**此处才是
配额信号真源**)。
- `_officialChatReplay` 回包处理重写：经 `parseFrames` 解 gzip 后,**按帧型分流**——end-stream
  帧(bit1)按 JSON 解析取 `error`;data 帧按 proto 收集助手增量文本。检出 `quota/exhaust/
  governor/precondition` → `_signalPremiumQuota("exhausted")` → 付费档实时转红、免费档恒绿。
- 实测(账号当日配额已尽)：付费 claude-sonnet 经反代真转上游 → 解出真·上游报文
  「Your daily usage quota has been exhausted…」→ premiumQuota 翻 exhausted → 119 模型即时
  **18 绿(8 免费+10 渠道) / 101 红 / 0 琥珀**,与渠道配置同源全量着色一致。
- 自检 [12] 扩充：end-stream gzip 帧解压 + JSON error 解析 + quota 正则命中,共 32 断言全过。

v9.9.324 · 官方直通捕获帧解析归一(反者道之动 · schema 自适应 · 逐字节保形)
: 修复 ④ 模型反代「官方直通」实测报「捕获帧解析失败」。真因：新版 Cascade GetChatMessage
wire 已将**消息数组从 field2 迁到 field3、正文从 sub-field2 迁到 sub-field3**，旧 `findMsgsField`
误把 field2(15883B 系统提示长串·`looksLikeUtf8Text` 命中)当消息数组、且 `_pbCloneSwapStrings`
仅换 <200B 纯 ASCII 短串、容不下多行长正文 → 解析必败。
- `_swapLastUserMsg` 重写为 **schema 自适应**：候选 [3,2,10,17] 里挑「末条目可解析且含字符串正文」
  者为消息数组，末条目内取「最长 UTF-8 子字段」为正文，经 `_pbRebuildField` 沿 path 逐字节重算
  长度前缀替换（只改末条、其余原样保形），不再依赖短串白名单。
- `_officialChatReplay` 摘除 `connect-content-encoding/grpc-encoding` 头（`buildFrame` 恒输出
  uncompressed，留 gzip 声明会被上游误解致 400）。
- 自检新增 [12] 捕获帧解析回归：新wire(field3)/老wire(field2)末条正文换入 + 首条保形 + 空帧不崩。
  revproxy 自检 29 断言全过。

v9.9.323 · 模型反代「全量呈现 + 配额着色 + 官方直通」(道法自然 · 万物并育而不相害)
: ④ 模型反代不再只列已接通的若干模型，而是像「② 渠道配置」一样**全量呈现一切可反代之模型**——
官方全量目录(108)+ 运行时官方家族 + 模型路由表 + 渠道显式 models，去重并育于一张列表。

① 配额着色(绿/红/琥珀) — 每个模型按「配额/费档」实时着色：免费档(swe-1-6 等 7 个 FREE)与已接通渠道
**恒绿**；官方付费档随付费配额观测态着色——有配额=绿、配额耗尽=**红**、未探测=琥珀。面板含图例统计
(🟢N 🔴N 🟡N · 免费N · 付费配额态) + 状态过滤(全部/可用/无配额/免费/渠道) + 关键词搜索。

② 官方直通(免费模型脱离配额) — `revproxy.js` 新增官方直通分支：未映射第三方渠道的官方模型经
`source.js` 捕获最近一帧真 GetChatMessage 请求、换入新 user turn 后真转云端官方推理链、解码回包
(`_officialChatReplay`)。免费档即便付费配额耗尽仍可反代出包。未预热时返回明确提示(非伪成功)。

③ 接口 — `/origin/revproxy/status` 与 `/v1/models` 现回传全量模型 + `color/status/note/free/costTier`
及 `stats`、`premiumQuota`；命令面板「查看模型反代」与 ④ 面板均按此着色。自检 revproxy 25 断言全过。

v9.9.322 · 新增第四面板「模型反代」(反者道之动 · 脱离 Devin Desktop · 标准本地端点)
: 在原三面板(①本源观照 ②渠道配置 ③模型路由)之上新增 **④ 模型反代**。把「②渠道配置/③模型路由」
里已接通的模型(免费 GLM、官方家族映射、任意 OpenAI·Anthropic 兼容渠道)**反向**暴露为标准本地端点，
脱离 Devin Desktop，供智能家居 / 本地脚本 / 其他设备以标准 SDK 直接调用。

① 本源(反者道之动) — 正向是 Cascade→上游(source.js)；反代是「入站标准请求→经渠道配置/模型路由→
标准格式回吐」的反向同源通道。新模块 `vendor/外接api/core/revproxy.js` 自包含(只依赖 node 内置 +
同目录 adapters.js)，由 source.js 在 `/v1/*` 与 `/origin/revproxy/*` 路径委派。

② 端点(标准·即插即用) —
  · `POST /v1/chat/completions`(OpenAI·流式+非流式) · `GET /v1/models`(枚举可反代模型)
  · `POST /v1/messages`(Anthropic·流式 event/非流式) · Header `Authorization: Bearer <本地Key>`
  · 上游协议自适应(openai-chat / anthropic)，复用 adapters.js 解析 SSE 再以客户端所需格式回吐。

③ 鉴权与配置 — 配置落 `~/.codeium/dao-byok/revproxy.json`：`{ enabled, apiKey, applyInvert,
exposeLan, defaultMaxTokens }`。`apiKey` 空 → 仅 127.0.0.1 放行；首次自动生成 `dao-local-*` 落盘。
`applyInvert` 默认关(透传用户自有提示)，开启则对入站 system 施「本源观照」(invertSP·剥官方着相归本源)。

④ 面板与命令 — ④面板含 启用开关 / 本源观照入站开关 / 端点+Key 一键复制+重置 / 可反代模型列表 /
一键自测(选模型→发标准 OpenAI 请求→验证全链路·适合 GLM 等免费模型)。新增命令
`dao.revproxy.toggle`、`dao.revproxy.status`。自检 `npm run test:revproxy`(mock 上游·零外发)全过。

v9.9.321 · 根治「过几小时环境一变又卡死·必须卸载才能用」(端口锚点漂移自愈·反者道之动)
: 根治本源级老问题——所有模块卡死在「Connecting to server…」中间态、必须完全卸载插件才能恢复。

① 本源(真机实证) — 多个 IDE 实例(Devin / Devin-i1 / Devin-i2 / Devin-123 …)各持独立
`%APPDATA%\<IDE>\User\settings.json`。FNV(os.userInfo().username) 同名同算同端口(如
Administrator→8937),但同刻仅一个进程能绑定它。启动竞态下落败的实例 `_ephemeralBind`
退避到 OS 空闲端口(8938/8939/9627…)并把它写进「自己的」settings.json。其属主 ext-host
一旦重载/退出,该临时端口随之死亡 → 该实例 language_server 永远 `--api_server_url
http://127.0.0.1:<死端口>` → 永「Connecting to server」。环境一变(重启/休眠/进程回收)
就触发,反复发作,只能卸载(卸载会还原官方直连)才恢复。

② 旧看门狗为何自愈不了 — watchdog 每 60s 只 ping「自算 FNV 端口 `_cachedPort`」(此刻
正被别的活窗占着,恰好健康)→「安心」早返,从不校验「本实例 settings.json 真正锚定的
那个端口」是否还活着 → 8937 活、8939 死的分裂态永不收敛。

③ 治法(损之又损·无为而无不为) — 看门狗改以「真实锚定端口」为准:
  · 新增 `_readAnchoredPort()` 从本实例 settings.json 读 `codeium.apiServerUrl` 的真实端口;
  · 每周期先 ping 该真实端口的 `/origin/ping`,死/非 dao 反代 → 触发收敛:重置健康标志、
    回 FNV 规范端口经 `proxyStart`(内含 `_reusePublishedProxy` 多窗口复用)收敛到单一活反代,
    `setAnchor` 改写 settings 并重启 LS;若全无可用反代 → `clearAnchor` fail-safe 还官方直连。
  · `setAnchor` 落锚前必当场 ping 确认端口真活(旧版仅凭启动时置一次、从不复核的 `_proxyHealthy`
    旗标即写,会把死端口写进 settings)。死则拒写、改 fail-safe 还官方,杜绝锚死端口。
幂等、20s 重启去抖、同值不写,不扰正常设备;活窗自动收敛,无须卸载。

v9.9.319 · 模型解锁根治(新架构+自愈+结果自检) + ③面板救生索(道法自然·反者道之动): 根治「新用户只剩 SWE-1.6 Slow / 其他全灰」以及「一重启 IDE 插件就没了」两大核心问题。

① 新架构解锁 — 新版 Windsurf/Devin GetUserStatus 已弃「Upgrade to Pro」徽标, 改用每模型 field20 可用标记(varint=1)控制: 免费层仅 SWE 系 4 个模型带 field20, 其余 65+ 个模型无 field20 → picker 全灰。旧徽标剥离在新架构下无锁可去(calls=0), 只剩 SWE 系可选。治法(利而不害·只增不改): 新增 proto 工具链(_pbReadVarint/_pbEncVarint/_pbTag/_pbHasField/_pbRebuildField), 沿 top.f1.f33.f1[] 为每个缺 field20 之真模型项(含 field22+field23)补 field20=1, 不删任何字段·不破坏原结构。老架构(有徽标)走原有剥离路径不变, 新架构(无徽标)走新分支 _pbEnsureModelsAvailable。离线验证: 真实抓包 33285→33480B, 69/69 全可用。

② 解锁自愈(ensureUnlockFlowing) — 根因: LS 由 IDE 开机即刻 spawn, 反代异步启动(≈8s 健康·≈15s 锚定); spawn hook 失败安全门「反代没就绪就不改写 LS 端口」→ LS 直连官方 → GetUserStatus 不经反代 → 全锁。LS 一旦直连就保持到下次重启。修复: activate 后 22s 核查 LS 是否真经反代(改写计数 + GetUserStatus 计数), 反代健康却两者皆 0 = LS 漏改写直连 → 一次性重启 LS, 重生即经反代解锁。幂等, 不连环杀·不扰正常设备。

③ ③面板 SWE-1.6 Slow 救生索(_ensureLifelineFamilies) — _getOfficialFamilies 返回的官方家族目录无 swe-1-6-slow 独立项 → ③左侧永不显示 → 用户无法连线第三方。修复: 在家族列表末恒补「SWE-1.6 Slow」(lifeline=true), 与 SWE-1.6 Fast 对称, 始终可见·始终可连第三方, 作最后兜底。

④ 结果级自检(可观测·零回归) — 以前解锁成功与否无人知(静默失败)。新增 _unlockStats 三字段: last_total(总模型数)·last_available(可用模型数)·schema(old-badge/new-field20), 每次 GetUserStatus 拦截后自动统计并暴露在 GET /origin/status real_unlock 里。一看即知「解锁了几个/总共几个/走的哪条路径」, 静默失败→可观测。

实证: xiaogao(老架构) GetUserStatus.calls=4, dropped_total=256(剥掉 256 处 Pro 锁), schema=old(badge), 全模型解锁; 1h8(新架构) 离线验证补 65 项 → 69/69 全可用, schema=new(field20)。familyTierExtend 保持默认关(道法自然·最小化操作)。

v9.9.318 · 根治「外接 API 的 ask_user_question 不弹窗」+「对话无征兆中断」两症(用户旨意·逆官方 Pro 路径到底层): 与官方模型完美并存、20 个快速选工具全可用之上，补齐两处外接 API 与官方路径的核心差异。

① ask_user_question 弹窗 — 逆向实证(zhoumac Pro 机 windsurf/dist/extension.js): 官方弹窗由 LSP 把 chat 层 ask_user_question 工具调用转为 cortex 层 RequestedInteraction{ask_user_question: CascadeAskUserQuestionInteractionSpec}(CortexStep field no:56 requested_interaction)→ 渲染阻塞式弹窗。官方模型问问题时*单发* ask_user_question 即停(终止性，问完等用户)；外接模型常把它与 multi_edit/read_file 等同轮打包发出(实证 _router_diag: "names=ask_user_question,multi_edit")→ LSP 把整批当普通工具执行，永不触发弹窗，对话无感继续。修复: 流式 `_flushTools` 与缓冲 `tool_calls` 两条发射路径均隔离——本轮一旦含 ask_user_question 且有兄弟工具，即只保留 ask_user_question、丢弃同轮兄弟(用户应答后模型自会重规划)，复刻官方「单发即停」形状 → 弹窗正常弹出。仅在 ask_user_question 与他者同轮时触发隔离，单发或无 ask 的批量工具不受影响 → 20 个快速选工具照常并发。

② 对话无征兆中断 — 逆向实证: 主流式 `_streamOaToCascade` 仅在收到上游数据时写帧。外接模型中途静默 >~10s(慢推理/token 间隙/网络抖动但 socket 未报错)时无帧可写，agRes 'error' 不触发，LSP 客户端约 10s 无新数据即 abort →「对话毫无征兆中断」。上游*报错*已由 agRes.on('error') 优雅 STOP_END 兜底；此处补的是上游*静默不报错*的缺口。修复: 与重试路径同法，主流式加空闲保活——`setInterval` 每 ~2s 检查(阈值半值，钳于 200~2000ms)，空闲达阈值(默认 5000ms，可经 `DAO_IDLE_KEEPALIVE_MS` 调)即补发一帧 DELTA_THINKING 保活，收到真实数据即复位，流结束/出错即 clearInterval；`.unref()` 不阻进程退出。道义: 五十二章「守柔曰强」· 守流不绝则不断。

线协议级回归测试: lsp_sim_run.js §5.5b(同轮打包→只剩 ask_user_question·不污染最终 stopReason/工具) + §5.5c(静默 stall 下保活启用/禁用对照·帧数与 thinking 变化·两遍工具结果一致)。全量绿: dao-test 318/0、lsp_sim 288/0。与 v9.9.317 官方聊天钉主机修复正交，三第三方路由/模型解锁/官方并存均不受影响。

v9.9.317 · 根治「装插件后官方免费模型报错·官方聊天被错路到 inference」(用户旨意): Pro 账号不装插件时语言服务器(LS)原生直连 server.codeium.com 一切正常；装插件(invert 拦截)后, 代理按方法名将官方聊天 GetChatMessage/GetChatMessageV2/RawGetChatMessage 路由到 UPSTREAM_INFER(inference.codeium.com), 而该账号在 inference 主机上对这些聊天方法确定性返回「third-party model provider unavailable」→ IDE 报 Model provider unreachable。故「不装插件正常·一装就报错」。实证(直连 replay·同一请求同字节): → server.codeium.com 得 HTTP 200 真实聊天流响应; → inference.codeium.com 得错误 JSON。修复: 官方 chat 方法的回传主机 UPSTREAM_INFER → UPSTREAM_API(server.codeium.com), 与 LS 原生 --api_server_url 一致; 被路由的第三方/BYOK 模型在更早的 _eaRouter.route()(按 kind 分流)即拦截转发, 不走此 host 选择, 故第三方路由/模型解锁不受影响。实证(VM·拦截全程开启): 装着插件连续 4 条免费 SWE-1.6 全部正确(56/81/42/12), 无 Model provider unreachable, 状态栏干净; 代理日志确认 GetChatMessage → server.codeium.com st=200(真实流帧)。

v9.9.316 · 根治「免费模型无法与 Proxy Pro 并存」(用户旨意): 有用户反馈 Pro 账号(premium 额度用尽·仅免费档可用)装上 Proxy Pro 后, 选免费 SWE-1.6 收到的是固定桩文本(「道可道也…stub响应正常」)而非官方真实回复, 免费模型无法与第三方路由并存。根因: `init()` 无条件将基础档 `MODEL_SWE_1_6` 播种到 `builtin-stub`(路由表`_routes`), 使 `shouldRoute(swe-1-6)=true` → 命中桩路由 → 官方透传被劫持。修复: 移除两处播种(默认模板 routes + 幂等补线块), 基础档不入路由表 → `shouldRoute(swe-1-6)=false` → 回落官方上游(免费原生)。仅 SWE 1.6 Fast 按用户配置路由(deepseek), 未填 apiKey 时亦回落官方。实证(VM): 修复后免费 SWE-1.6 发「Reply with exactly this and nothing else: COEXISTFREEOK」得官方真实回复「COEXISTFREEOK」(非桩文)。测试: dao-test.js L2.6 断言同步更新为修复后行为, 全量 npm test 307 通过 0 失败。

v9.9.315 · 根治「卸载后仍 Unable to connect」最深本源——IDE 自带扩展被就地打补丁的死端口 (用户旨意): v9.9.314 已把 settings.json 锚点/端口文件/证书/环变全部归零, 但用户实测卸载+重启后仍报「Unable to connect to Devin」。深挖发现真凶不在本扩展、也不在任何扩展状态里, 而在 **IDE 自带的内置 windsurf 扩展文件** `resources/app/extensions/windsurf/dist/extension.js` 被就地写入了 3 处死本地端口硬编码: `restart(A){A="http://127.0.0.1:3000",...}`、`getApiServerUrlFromContext=A=>{return"http://127.0.0.1:3000"}`、`const i="http://127.0.0.1:3001"`(inference)。实证: 官方 language_server 被以 `--api_server_url http://127.0.0.1:3000 --inference_api_server_url http://127.0.0.1:3001` 启动, 而这两个端口无人监听 → 卡死。因补丁写进了 IDE 程序本体, **卸载任何扩展都不碰此文件**, 故重启后仍连死端口。本版: ①新增 `_revertBundledExtensionPatch()`——卸载/复原时定位 IDE 内置 `windsurf/dist/extension.js`(多策略: `vscode.env.appRoot`/`VSCODE_APPROOT`/`execPath`/常见安装路径), 仅命中 dao 注入签名(端口任意)时才改, 改前备份 `.dao_patched_backup`, 还原为官方云端(`server.codeium.com` / `inference.codeium.com`); 接入 `_purgeDaoLsResidue()` → 卸载与 `cmdRestoreOfficial` 自动覆盖; ②独立 reset 脚本 `dao-reset.ps1`/`dao-reset.sh` 新增第⑦/⑥步同款还原(IDE 未运行时可用 `-IdeRoot`/`DAO_IDE_ROOT` 显式指定安装根); ③`dao-reset.ps1` 补 UTF-8 BOM, 修 PowerShell 5.1 在非 UTF-8 代码页下解析中文脚本报错。卸载即彻底归零, 含 IDE 本体补丁。

v9.9.314 · 根治「卸载+重启 IDE 仍卡 connection erroring · 无法整体清空归零」(用户旨意): v9.9.313 只清了 settings.json 的 LS 外置重定向键, 但用户实测卸载+重启后仍跳「Client windsurf: connection to server is erroring · Unable to connect」。两条更深的真因: ①**锚点未在卸载时无条件清除**——`deactivate` 的智能保锚 30s 门限是为「重载」防写风暴而设, 但「卸载」后扩展永逝、没有下一个 ext-host 来 auto-restore, 于是 `codeium.apiServerUrl=http://127.0.0.1:<死端口>` 被永久留下 → 重启后 Cascade 连死端口 → 卡死。`deactivate` 必须能区分「重载」(该保锚) 与「卸载」(必须清锚)。②**系统级残留卸载根本不碰**: `~/.codeium/_dao_ls_port.txt`(死端口 19999, 旁有 `.dao_backup` 官方原值) · `~/.codeium/dao-certs/` + 信任区自签 `CN=server.codeium.com` MITM 证书 · `CODEIUM_LANGUAGE_SERVER_BIN` 持久化环变。本版: ①**真卸载侦测** `_isSelfUninstalling()`——读 `<extensions-root>/.obsolete`(IDE 卸载流程在 deactivate 前先写入本目录), 多信号兜底(本目录/本族目录命中, 或本扩展已不在注册表); 侦测到卸载即越过 30s 门限**无条件清锚 + 复原官方直连**; ②**系统级残留归零** `_purgeDaoLsResidue()`——还原/删 `_dao_ls_port.txt`、删 `dao-certs/`、detached 子进程解信任自签 MITM 证书并清 `CODEIUM_LANGUAGE_SERVER_BIN`/`VSCODE_DEV` 持久化环变、删 `_dao_csrf_token.txt`; 保留不动 `dao-byok`(主公 key) 与 `dao/`(Cascade 记忆); ③`cmdRestoreOfficial` 一并执行系统级残留归零; ④新增**独立 reset 脚本** `scripts/dao-reset.ps1`(Windows) / `scripts/dao-reset.sh`(macOS/Linux)——不依赖扩展存活, 扩展被 force-remove(deactivate 没跑) 后亦可一键归零, 带 `-DryRun`/`--dry` 预演。卸载即彻底归零, 还官方直连。

v9.9.313 · 根治「原生卸载后官方服务器连不上·卡死中间态」+ 复原官方直连命令(用户旨意): 真因实证——卸载后 `settings.json` 残留 `codeiumDev.externalLanguageServerAddress: 127.0.0.1:19999`(把官方 Cascade 语言服务器重定向到本地外置端点), 代理/插件一去该端口即死, 官方 LSP 连不上 → 卡死中间态; 而原解锚仅清 `codeium.apiServerUrl` 系、从不碰这条 LS 外置重定向(此键由同族旧世代/残留写入, 本扩展走 Connect-RPC 层不写它)。本版: ①新增 `_restoreOfficialDirect()` 跨所有候选 IDE 的 `User/settings.json`(devin/Windsurf/Code/VSCodium + ctx 上溯本实例) 清除重定向键, 写前带轮转备份; ②`deactivate`(卸载/停用必经) **无条件**清除 `codeiumDev.externalLanguageServerAddress`/`externalLanguageServerLspPort`(本扩展从不写之 → 清之无写风暴 → 不受原 30s 门限约束), `codeium.apiServerUrl` 系仍按原防写风暴逻辑; ③新增命令「道Agent Pro: 复原官方直连 (卸载善后/解锚 · 卡死自救)」(`dao.restoreOfficial`): 完全清除重定向(含 apiServerUrl 与 LS 外置)+停本地代理+提示 Reload Window, 即便已卡死也能在命令面板一键自救。卸载后官方语言服务器自连, 不再卡中间态。

v9.9.312 · 根治「首次添加渠道探活失败·须重启+手点探测」+ 交接文档一键复制(用户旨意): 两处真因合治——①**自写抑制根除热重载竞态**: 每次热保存(加渠道/解模型)改写 `配置.json` 会触发 `fs.watch` → `init()` 全量重载 → `_providers` 被替换为新对象, 与正进行的「解模型→落 `cfg.models`→探活」内存改写打架, 致解出的模型不落、探活退化; 新增 `_lastSelfWriteData` 记录本进程写盘内容, 监听回调比对磁盘内容一致即判「自写·跳过热重载」, 仅外部手改方重载。②**探活前先解模型·绝不用渠道名当模型**: `probeAllProviders` 在 `_verifyProviderChat` 前若 `cfg.models` 空则先 `hotListProviderModels({refresh})` 拿真实模型再验; `_verifyProviderChat` 去掉 `|| name` 退化(旧法无模型时把渠道名当模型发 → 上游 400「you passed <渠道名>」误判失败), 无真实模型则明确返回「需先拉取模型」。合治后首次添加即解即探即绿、启动自动探活无需手点。③交接文档面板加「📋 复制最新状态」按钮: 一键取 `/origin/ea/handoff.md` 最新全文写入剪贴板(浏览器剪贴板不可用则经宿主 `vscode.env.clipboard` 兜底), 直接粘给本地任意 Agent 即可接管热配置一切。

v9.9.311 · 预设不重置已有体验、添加后自动识别道部模型(用户旨意): 预设 `_PRESETS` 去掉硬编码候选模型 m 字段，只给「显示名/协议/BaseURL/注册页」，选设后模型输入框留空(占位提示自动识别)，填 Key 添加后即按 `/v1/models` 全量拉取该渠道真实可用模型——既不覆盖已配渠道的现有体验，又对新建渠道做到只填 Key 即全识别，各家通治。

v9.9.310 · 端点发现档 + 接管手册(去中心交接): server listen 时随成落盘 `~/.codeium/dao-byok/endpoint.json`(随接力档刷新)，让任意远端 Agent 凭固定路径定位到运行中控制面板真实 base/port，即使临时端口轮换亦能连上；交接文档新增「接管手册」三段式：接入 + 扩展热配置 API(提示词经藏/自定义 SP/观照/用量/发现模型/热增渠道与路由)，使拿到档案的 Agent 可直接修改、管理插件与切换。

v9.9.309 · 渠道配置「打印配置JSON」按钮 + 模型路由采样度/Token 上限视图(用户旨意): ①渠道配置面板工具栏加按钮 → postMessage(openConfigJson)，宿主侧 `_resolveDaoConfigPath()`(同 runtime 序优先 `~/.codeium/dao-byok/配.json`·退 VSIX 内) + `_openConfigJson()` 在编辑器中打开配置件，便于查看/排错；②模型路由弹窗新增「Max Output Tokens」(单次回复上限)与「采样温度 Temperature(0~2·留空=默认)」字段，编辑时填写、保存随路由持久；`dao_router._callProvider` 读 `target.temperature`(仅有时)注入 bodyObj.temperature，留空不发、行为不变，max_tokens 既有逻辑不动。

v9.9.308 · 渠道适配指名相告 + 首条消息 TTFB 守护: ①渠道适配「指名相告」(参 cc-switch)——`classifyChannelResponse` 增 `_CHANNEL_HINTS`：模型未开通/Key 无效/余额不足/中转 503 上游不可用/限流/拒绝等，给可操作文案而非笼统「不可用」；`_NON_CHAT_RE` 补 t2v/i2v/t2i/seedance/seedream/seededit/video/sora/cogview/wanx/kolors/flux/mj 等，自动发现模型时剔除视频/图像生成模型(原已过滤 embedding/tts)，防其当对话模型被路由致失败，多模态对话模型(vision-pro)仍保留。②首条消息 TTFB 守护——长闲后第一条上游 200 但响应迟迟无字节(半冷 socket 静卡)致 Cascade 端死等、用户感首条被吞；`_tryRoute` 在上游 200 后先下发响应头并以 `_awaitFirstByte`(readable+read+unshift 探字不耗首字节)守首字节，超 `_TTFB_FIRSTBYTE_MS`(默 8s·可 `DAO_TTFB_MS` 调)内无首字节判卡，销毁本连并仅重试一次新接(限一次防双死回退·仅流式下头生效·用户无感)；mock 自测 307/307 全通。

v9.9.307 · 本源观照面板显示三个实时之文真游(观感不变·仅观通): 旧面板取 source.js 侧 devin body 之 SP after(经文部分)、且 tape limit=1 常取到末尾的 devin 子 RPC(summary/title/memory)之注入，非三实全文。本版 `dao_router._callProvider` 组装最终请求体后经 `global.__DAO_RECORD_UPSTREAM` 回传 {provider,model,messages,tools}；source.js 建 `_lastUpstream`(system+messages+tools 可全)暴露 `/origin/upstream`、`/origin/sig` 加 `upstream_last_at`；面板优先显真游全 all_fields(无则回退 tape)，host 推送不覆盖新真游。效果：路由第三方时每条消息即显三实之 system(官方+DAO 增量)+对话上文+工具清单全文，不再仅静态经文滞后子代理。

v9.9.306 · 经藏热切真效·注入前以持久化件为准: 根因——`hotReloadCanon()` 自 v9.9.94 定义但从未被调用(死代码)，外部改 `_origin_canon.txt` 而未走 setCanon 时，多窗口 watchdog 复制之 ext-host 实例从不重读 → 切经不动(恒为 laozi+yinfu 默认)。本版执于一源：sp_invert.js 的 `invertSP`/`invertAnySP` 注入前 `_maybeHotReloadCanon()`(节流 500ms·只读 11 字头·不变则不热载)→重读 `_origin_canon.txt`；dao_router `_getDaoEnhanceText` 注入前 `hotReloadCanon()`。复测：invertSP 恒 7921(laozi+yinfu)、yinfu→709 / laozi→7315 / laozi+yinfu→7921，三式随件入随变。

v9.9.305 · 加渠道即解析模型探测·修首次添加失败需重启: 旧探测 `_verifyProviderChat` 用 `cfg.models[0]` 当试探模型，但新渠道首次添加尚无模型，退用当前 model 发 chat → 被拒 → 探测失败，需重启后模型缓存才通。本版加渠道流程改为：先 GET `/models?refresh=1` 全量解析模型落 `cfg.models`，再 `_autoProbe`，使首次添加即有真实模型探测、无需重启窗口。

v9.9.304 · 修复添加渠道 URL 被吃掉字母 s 的回归: 9.9.303 在前端 webview 模板字符串里写的 `replace(/\s+/g,'')` 被面板转义成 `/s+/g`，导致保存渠道时 URL 里凡有字母 s 被吞(https→http、paas→paa、deepseek→deepeek)，全渠道探测失败；本版前端不做去空白(去空白由后端 `hotAddProvider` 正确处理 'http s://' 空格)。

v9.9.303 · 根治「本源观照面板：热切换经藏(单道德经/单阴符经/合一)在面板里完全无效、且只显经文而非实时注入到模型的全部文本」(实证根因·非 HTTP 层而在 webview 取数路): 痛根——webview `pull()` 取 `/origin/tape?fields=0` 之「最近一条」并渲染；外接 API 接通后，最近一条恒为 summary 子代理(英文)，且其 `after` 为捕获时定格、不随经藏热变；该 `pull()` 每 30s 及每次 sig 变即覆盖 `data`/`canonChanged` 通路已正确写入的「随经藏当场重算」之文本 → 面板遂「恒显英文/经文、切经无效」。v9.9.302 仅修了 `/origin/preview`(扩展侧状态栏取数)，未触及 webview 这条 `pull()` 取数路，故面板观感不变。本版三处归一：①`/origin/preview` 新增实时重建的 `all_fields`——取主 `chat` 槽全字段，SP 类(chat/summary/memory/ephemeral)以 `invertAnySP(原文)` 当场重算 → 切单道德经/单阴符经/合一即时反映；raw_text/user_msg/tool_def 等全字段皆返 = LLM 实收之一切文本。②webview `pull()` 改取 `/origin/preview`(主 chat 槽·随经藏重算)替代 `/origin/tape` 定格旧条 → 切经即变 + 全字段实时显，不再被 summary 子代理英文覆盖。③`data` 通路 SP 内容交由 `pull()` 的 all_fields 全文独主(仅同步 lastSP/按钮/经名/徽标)，`canonChanged` 即时触发 `pull()`，三写一源、无闪烁。结果(zhoumac 面板 UI 实证)：切单道德经/单阴符经/合一面板文本即时随变；面板显示当前实时注入到最上游 API 的全部文本(系统提示词+用户消息+工具定义+历史)，非仅静态经文。

v9.9.302 · 根治「外接渠道加了 DeepSeek/小米后完全不可用」(实证根因·载入即自愈): 旧版「添加渠道」分隔符正则退化（`/[\s,]+/` → `/[s,]+/`，把字母 s 误当分隔符），将 baseUrl/apiKey 按字母 s 切碎并持久化（如 `https://api.deepseek.com/v1` → endpoints=["http","://api.deep","eek.com/v1"]、baseUrl="http"），导致渠道指向无效主机、整套外接 API 形同虚设，且升级新版后脏数据不自愈。本版：①新增 `_reassembleSplitUrl` 载入即自愈——s 为唯一被吃分隔符（URL 无逗号/空白），顺序碎片以 "s" 重接即原样复原（`["http","://api.deep","eek.com/v1"].join("s")` = `https://api.deepseek.com/v1`），仅当 baseUrl 为裸协议碎片且重接为合法 URL 方施治，不误伤正常多端点；复原后按含/不含 /vN 重判 completionPath，清除旧的 `/v1/chat/completions` 错值防双重 /v1。②`_joinCompletionUrl` 增防双重版本段守卫：root 已以 /vN 结尾且 completionPath 又以 /vM/ 开头时去 path 版本段（deepseek/GLM 等通治）。注：被 s 吃掉的 API Key 字符已永久丢失，需在面板重粘一次（现版分隔符已正确，不再切坏）。③根治「本源观照实时提示词只显示子代理总结词、切单经/编写看似无效」(实证同一根因)：`/origin/preview` 旧逻辑取单槽 `_lastInject`——会被「summary 子代理」RPC 覆盖；且旧变换 `invertSP` 仅识主 Cascade、对 summary 返回 null → after 回退显示原始英文子代理总结词，遂令面板恒显那条英文、切单道德经/单阴符经/编写都「看似无效」(实为预览被占)。本版预览取槽归一：优先主 `_injectsByKind.chat`（缺则回退 `_lastInject`）、变换改用 `invertAnySP`（识 chat/summary/memory/ephemeral·即 LLM 实收文本，退 `invertSP` 再退 before）——面板恒显「当前实时注入到 Agent 的主提示词」，切经藏/单经/编写即时可见(实测 单道德经=7170 / 单阴符经=632 / 合一=7766 字·均道经化中文)。

v9.9.301 · 多Key/多端点加权负载均衡+故障转移·用量成本可见·配置原子写(用户旨意): ①P0-1渠道可配 apiKeys:[]/endpoints:[{url,weight}](渠道配置面板 URL/Key 逗号分隔即启用)·请求按权重选首选+遇可重试错误(429/5xx/401/403/网络异常)自动切下一候选·仅响应头未发出前转移(大制无割)·单key被限额/被封不致中断「全都能用」;②P1按渠道/模型聚合 token 用量(入/出/合计·调用次数)·新增 GET /origin/ea/usage·并注入 overview·渠道配置面板每渠道直显「▦ N次·Xk tok·≈$成本」(配 pricing:{inPer1k,outPer1k}时估算)·最小化前端·用户自查耗用;③P2-9 _hotSaveConfig 改原子写(临时文件+rename)+备份轮转(.config-backups 保留最近10份)·防写入中途被杀损坏配置.json · v9.9.300 · 渠道模型自动识别·适配一切底层(用户旨意): ②渠道配置「拉取全部模型」过去一律 Bearer + 仅探 /v1/models→Anthropic(需 x-api-key+anthropic-version)·Gemini 原生(需 x-goog-api-key + /v1beta/models)·GitHub Models(目录在 /catalog/models 而非 /inference/v1/models)等家族探测失败而回落到预设里仅有的两三个种子模型(故现象:DeepSeek/各家「只识别两个」);本版令 hotListProviderModels 按协议/家族择认证头(Bearer/x-api-key/x-goog-api-key·并尊重 authHeader/extraHeaders)·并在候选端点最前加入 GitHub Models 目录、Gemini 原生 /v1beta/models、Anthropic /v1/models?limit=1000·解析时去除 Gemini 「models/」前缀——用户只填 API Key 即自动全量解析该渠道所有可用模型(实测 GitHub Models 7→35 个);种子模型仅作离线兜底;③前端「加 Key 即自动全量识别」:已配/预设渠道在面板首载时自动后台热探一轮(_autoDiscoverAll·节流串行·失败不断流)·无需再手点「↻全部模型」——这正是为何旧版只见预设种子(如智谱只到 glm-4.6·缺 glm-5/5.1/5.2)·实测智谱自动解出 glm-4.5/air/4.6/4.7/5/5-turbo/5.1/5.2 共 8 个、xiaomi 5 个;注:DeepSeek 一方 API 实返仅 deepseek-v4-flash/pro 两个(官方如此·非漏识别)·万邦皆通·道法自然 · v9.9.299 · 三模块面板①本源观照「编」兜底稳态修复(用户旨意): 旧版点「编」无 custom_sp 时回退 /origin/preview·而 preview 依赖实时捕获的 lastInject·无对话/捕获过期时为空→textarea「跳有跳没」不稳;改为永以 /origin/custom_sp 的 default_sp 填充(随 _activeCanon 动态·帛书老子/道藏阴符经名实相符)·切经藏时若在编辑亦随经重填·归道后重拉本源;与侧栏 EssenceProvider(v9.7.6/v9.9.22 已修)同源行为·彻底消除不稳定 · v9.9.298 · 路由默认归正·道法自然唯变所适(用户旨意修订): 将 familyTierExtend 默认由「开」改回「关」(可显式 familyTierExtend:true 开)——默认行为归正为: swe-1-6(基档)=测试通道(builtin-stub)·swe-1-6-fast=用户添加首个第三方渠道后自动以其首模型路由(maybeAutoRoute/添加 provider 时自动建路由·已存在则不覆盖)·swe-1-6-slow=默认走官方原生直通(免费·不路由·之前所谓「unreachable」仅 VM 连不上官方所致·真机官方可达)·亦可由用户显式连线或置 familyTierExtend:true 后路由第三方;②渠道配置默认内置 DeepSeek 预设(主页填 key 即用)+27 家软编码预设(含智谱/阿里云百炼/字节豆包火山方舟/腾讯混元/小米 MiMo 等·一键填入+🌐跳官网拿 key);全程软编码·不硬编码任何用户隐私(APIKey/手机号等仅存运行时本地配置·绝不入插件代码) · v9.9.297 · 同族档位延伸默开(已被 v9.9.298 归正): dao_router 的 familyTierExtend 由「默关·需手动开」改为「默开·可显式 familyTierExtend:false 关」——真因(实机):Cascade「SWE-1.6 Slow」下发的 swe-1-6-slow 在 catalog 中无独立项(仅 swe-1-6/swe-1-6-fast)·UI 无从单独连线·而旧默认下其归一逻辑被 familyTierExtend 闸死→漏路→回落 VM 不可达官方上游→「Model provider unreachable」;改默开后·用户在 ③模型路由 连了 SWE-1.6 任一档(fast/base)·同族全部档位(含 slow)即归一其外接渠道(守常:仅延伸含真实非播种路由之族·纯桩族仍保官方直通);并 maybeAutoRoute 对所连族全部可见档位逐一建路由·与后端延伸互补 · v9.9.296 · 连家族即覆盖全档位(模型路由): ③模型路由 连一族时·maybeAutoRoute 对该族全部可见档位 uid(取自 _tierGroups·与双击解路读 data-uids 全断对称)逐一建路由 · v9.9.295 · 选预设干净slug命名根治: _presetSlug 改为取名中首个ASCII词(含括注内·如「字节 豆包 火山方舟 (Doubao/Ark)」→doubao)·根治原先「英文在括号内+括外全中文」类渠道(豆包/腾讯混元/阿里云百炼/智谱/硅基流动/讯飞/阶跃/百川…)被先剥括号→塌成空→统一回退成`provider`致同名覆盖的缺陷·27家预设零回退零重名实测验证 · v9.9.294 · 渠道预设大扩充(太上下知有之·最小化用户操作): ①cc-switch 预设库由12家扩至27家·国内尽收(DeepSeek/智谱GLM/Kimi/阿里云百炼通义/字节豆包火山方舟/腾讯混元/百度文心千帆/硅基流动/魔搭/MiniMax/讯飞星火/阶跃星辰/零一万物/百川)+国际(OpenAI/Anthropic/Gemini/xAI Grok/Groq/Mistral/Together/Fireworks/Perplexity)+聚合(OpenRouter/AiHubMix)+本地(Ollama) ②每条预设含官网/注册页 r 字段·新增「🌐 注册/官网」按钮一键跳转去拿APIKey(无账号即注册) ③选预设自动生成干净slug渠道名(去括注/中文/空格) ④用户三步即用:选渠道→去注册→填Key · v9.9.291 · 道法自然·对话不中断·根治(179实机实证): 输出前连接级重试(cc-switch风健壮)——upstream/代理在出首字节前断连(socket hang up / before secure TLS / socket disconnected)时·headersSent=false 安全幂等·退避重试至3次自愈;且 catch 路径补置_lastErr·重试耗尽即回传可读错误帧(不再静默死亡·对话突然中断) · v9.9.290 · 外接底层无懈(参 cc-switch): ①渠道地址归一(剥误含补全后缀·根治小米类 baseUrl 双重路径404→全不可用) ②模型全量自动解(cc-switch 多候选 /v1/models 顺序探测+↻全部模型刷新·不再只显2个) ③APIKey 保全(编辑渠道留空=保留原Key·脱敏/空不覆盖·根治Key保存后消失) ④对话不中断(上游断流/缺finish_reason 已有产出则优雅封口STOP_END·本轮可继续) · 用户只输APiK·任意渠道任意模型皆自适配 · v9.9.288 · 模型路由(面板③)前端三件套+去名补全+上游错误回传: ①连线实时稳定化(rAF+滚动跟随·不再一卡一卡) ②大板块/小模型拖拽排序(长按拖拽·localStorage持久) ③1:1对齐开关(已路由两侧重排成水平直线·可回退) · 去名补全: _deOfficialName 扩展至工具参数描述(run_command Blocking 述"Cascade")+系统提示尾(CascadeProjects)·根治真实流量残留 · 上游错误回传: GitHub Models免费层限输8000token·Cascade真实请求(25工具+万字SP)→413·代理原挂起→现把上游4xx/413转可读错误回传Cascade(不再对话死亡) · v9.9.287 · 道无名·工具描述去名(根治路由模型自称Cascade/Windsurf): 官方工具描述内嵌产品名(browser_preview/edit_notebook 述"Cascade"·check_deploy_status 述"Windsurf")随 tools 字段透传给真实渠道·模型读描述里的"Cascade"当作自我身份→自称"Cascade"(纯deepseek无此·属上下文注入非工具反噬)·修复: _deOfficialName() 发渠前将工具描述中官方产品名 Cascade→"you"·Windsurf/Codeium→"the editor"(与道化SP「本无名」一致·不动工具名参数·机制不破)·_msgSummary 增 preview 全息预览(验证官方身份是否仍漏入消息) · v9.9.286 · 真实渠道直连(根治回弹): _callProvider 默认协议路径改为"有 baseUrl 即直连真实渠道"·只在无 baseUrl 时才兜底走本地070网关(127.0.0.1:11435)·根治"缺 noProviderPrefix 的真实渠道(deepseek/github)被错丢给未启动的本地网关→ECONNREFUSED→回弹"(此前 test-chat/probe 走直连路径故未暴露·真实推理 _callProvider 走兜底网关故回弹) · v9.9.285 · 渠道实证探活(名实相符): probe改发最小真实chat·看HTTP码+响应体拒绝文案·杜绝双向误判(freemodel /models=200却chat被拒Access Denied→旧报ALIVE假阳·github /models=404却chat实通→旧报DEAD假阴)·test-chat同辨伪成功(200+"Access Denied"→ok:false+channel_reason)·overview注入每渠道 health{alive,reason,status}供前端如实展示通/不通+原因 · 同族档位延伸改 daoRoutes.familyTierExtend 开关(默认关·显式逐档路由为本·slow→官方原生直通不被fast自动吞并) · 三模块面板: ①本源观照(道官编+经文+本源体池) + ③官方模型↔右侧Cascade 1:1活捕映射+连线路由 + ②cc-switch渠道+freemodel+加key即探活拿模型 + Agent热配置交接MD · v9.9.284 兄弟档位择优(VM实证修正): 同族兄弟档位选路时·真实外接渠道优先于 builtin-stub/substitute·杜绝"swe-1-6-slow 被导向测试桩(固定返回)而非用户连的 deepseek"(旧逻辑取字典序首位·桩档非_seeded时夺流) · v9.9.283 test-chat诊断照真源: 新增 dao_router.resolveRoute() 与真实推理路径(route())同一张 _routes 表·test-chat改用之·彻底消除"swe-1-6-slow 实际可路由却误报 route config not found"(旧逻辑直查持久化config且 _normalizeModelUid 未导出) · v9.9.282 同族兄弟档位路由(连一档即覆盖全族): 用户仅连 swe-1-6-fast→渠道 时·发消息默认下发的 swe-1-6-slow 亦归一同渠道·彻底消除"档位对不上→走官方→501回弹"·完成 v9.9.280 族级语义(纯播种桩族仍守官方原生) · v9.9.281 test-chat多字节修复: Content-Length按字节计(非字符数)·中文消息不再被截断·上游不再400 · v9.9.278配置持久化: 用户级 ~/.codeium/dao-byok 首启即播种接管(凭据绝不入库·升级重装不失) · 反者道之动

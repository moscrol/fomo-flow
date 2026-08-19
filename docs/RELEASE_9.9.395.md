# dao-proxy-pro 9.9.395 发布说明

本次发布包含从 GitHub 稳定版 `9.9.382` 到 `9.9.395` 的全部连续更新。目标是让 Devin Desktop 在使用第三方模型时，尽量保持官方上下文、工具调用和工作区行为，同时让模块②、③、④、⑥、⑦共享同一份模型与渠道配置。

## 安装包

- 文件：`dao-proxy-pro-9.9.395.vsix`
- 扩展 ID：`dao-agi.dao-proxy-pro`
- 安装后版本：`dao-agi.dao-proxy-pro@9.9.395`
- 安装后需要在 Devin Desktop 执行一次 `Reload Window`

## 1. 自定义模型与多渠道同步

- 模块⑦支持最多 16 个渠道优先级，可添加、编辑、删除、置顶和拖拽排序。
- 支持“按优先级故障转移”和“随机首选、会话内保持”两种策略。
- 只有用户显式加入的渠道才参与自动切换，不再扫描其他同名模型渠道。
- 首选渠道失败后按队列切换；成功渠道在当前会话内保持，兼顾上下文连续和提示缓存。
- 模块③选择⑦模型后进入共享编辑模式。③中的渠道增删、模型修改、思考强度、策略和排序会直接写回⑦。
- 普通路由只保存 `_customModelRef` 动态引用，不复制渠道列表，避免模块间配置漂移。
- 模块③提供“改为独立路由”，只有用户明确点击后才解除与⑦的同步。
- 删除⑦模型前会检查③和⑥引用，存在引用时拒绝删除并返回引用列表。

## 2. 模块联动

- 模块②渠道配置与模块⑦均可作为自定义模型创建入口。
- 模块③的模型选择改为下拉框，优先显示②已探测模型和⑦自定义模型，减少手工输入错误。
- 模块④模型反代动态读取⑦最新渠道队列，并显示渠道数量、顺序、协议和思考强度。
- 模块⑥协议中转可直接引用⑦模型，动态使用全部渠道，不需要修改⑦后重新创建中转档案。
- 模块⑥列表显示同步渠道链、优先策略、对外模型、端点和协议。
- 模块⑦顶部显示当前实际使用的 Provider、真实上游模型、首选/备用切换来源和失败状态。

## 3. Responses 与思考强度

- OpenAI Responses 固定使用 `/v1/responses`，不再错误复用 Chat 的 completion path。
- 映射到 `gpt-5.6-sol` 的质量型路由统一使用 Responses。
- `low`、`medium`、`high`、`xhigh` 等设置真实转换为 `reasoning.effort`。
- 每个备用渠道独立保存协议和思考强度，故障切换后不会沿用错误渠道参数。
- 修正 Responses 图片块、`instructions`、`reasoning.summary` 和 `store:false` 的请求结构。
- Anthropic、Gemini 和兼容 Chat 模型继续使用各自原生思考参数映射。

## 4. Devin 原生上下文、工具与缓存

- 默认模式改为 `devin-native`：保留 Devin 提供的完整消息历史、官方摘要、工具定义、工具结果和工作区状态。
- 项目提示词注入只替换项目提示词正文，不再改写原生工具契约。
- 不再默认注入 `dao_tool_search`、`dao_read_tool_output`，也不再把大工具结果替换为 `dao-output://` 引用。
- 不再由代理生成额外 checkpoint 或删除 conversation summary。
- 保留稳定 `prompt_cache_key` 和连接复用，让 Responses/上游负责增量前缀缓存。
- 达到代理工具内部重试上限时，仅屏蔽造成循环的代理搜索工具，继续保留 Devin 原生读写、终端和编辑工具完成任务。

## 5. 工作区搜索与 ACP

- ACP 启动时从 Devin 的 `session/new.params.cwd`、`additionalDirectories` 和扩展宿主工作区推断真实项目根目录。
- 已有正确工作目录保持不变，仅修复缺失或错误目录。
- 原生 Cortex 明确返回“工作区未注册”时，才启用有边界的本地搜索兜底。
- 本地兜底覆盖文件名、文本和代码相关性搜索，支持中文路径，并跳过 `.git`、`node_modules`、`Library`、`Temp`、`obj`、`bin` 等生成目录。
- 原生搜索健康时不拦截，尽量保留 Devin 官方执行器。

## 6. 代码结构调整

- 将大型外接 API Webview 从 `extension.js` 拆到 `ui/`，再按核心路由、自定义模型/协议中转、模型反代、内网穿透分为独立客户端文件。
- 将自定义模型注册表从 `dao_router.js` 拆到 `custom_model_registry.js`。
- 将工作区消息修复和本地搜索拆为 `acp-workspace-message.js` 与 `local_workspace_tools.js`。
- `extension.js` 和 `dao_router.js` 保留编排职责，降低后续修改冲突。
- 结构索引见 `docs/CODE_STRUCTURE.md`。

## 7. 本次验证

- `dao-test.js --quick`：307 项通过。
- 自定义模型注册、排序、动态引用和删除保护：全部通过。
- 协议中转与模型反代：四协议、动态多渠道和渠道显示断言全部通过。
- Webview 生成后语法、模块归属和共享编辑入口：全部通过。
- 缓存、上下文、工具、ACP、工作区策略、启动锚定和 CORS 回归：全部通过。
- 已打包并在 Devin Desktop 覆盖安装，版本查询为 `dao-agi.dao-proxy-pro@9.9.395`。
- 本机运行接口检查：overview 正常，模型反代状态正常。

完整逐版本记录见仓库根目录 `CHANGELOG.md`。

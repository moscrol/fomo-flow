# 道Agent Pro 项目提示词注入：安装、启动与跨电脑迁移指南

> GitHub 稳定版说明文档。仓库包含插件源码、严格项目提示词替换功能、跨电脑迁移指南和可直接安装的清洁版 VSIX。

## v9.9.421 更新

### Codex 热路由空响应与原生模型目录修复

- 修复上游只返回 reasoning、没有正文或工具调用时，代理错误发送 `response.completed`，导致 Codex 任务无输出直接结束的问题。
- 空响应会在同一渠道透明重试一次；仍为空时按用户配置的渠道优先级切换，全部失败才返回明确错误。正常正文和工具调用不增加请求轮次。
- 新增 `/codex-hot/v1/models`，按 Codex `ModelsResponse` 契约返回顶层 `models`，不再把普通 OpenAI `{data:[...]}` 目录交给 Codex 解码。
- 热路由模型元数据复用 Codex 本机原生模型缓存，保留原生基础提示词、工具模式、上下文和截断能力；只同步当前模型标识与用户选择的推理强度。
- Claude/Devin 普通质量路由继续使用 `devin-native` 工具工作流。插件不追加检索工具、不代替 Devin 执行工具，也不为减少调用而改写官方工具契约。

## v9.9.420 更新

### Codex / Devin 文件差异双视图同步

- ⑧捕获的真实文件前后快照会同步注册为 Devin/VS Code 原生 SCM `Codex / Devin 文件变更`，原生绿色新增、红色删除和⑧面板共享同一组文件路径与 SHA-256 前后哈希。
- 点击任一差异入口前会即时读取磁盘，避免文件监听防抖期间打开旧 Diff；SCM Quick Diff 的原始侧和⑧回退使用同一份捕获前内容。
- Codex 修改后又被 Devin、编辑器或外部程序继续修改时，来源会归并到同一文件项；Reject 会校验最终磁盘哈希，拒绝用旧轨迹覆盖新代码。
- 插件不会为了制造绿色差异而回滚再重写文件，也不会伪造 ACP 工具卡。Devin 原生 SCM/DiffZone 与⑧审阅区可同时使用，显示内容均来自真实磁盘和同一捕获基线。

## v9.9.419 更新

- 修复 `http://127.0.0.1:8919/codex-hot/v1/responses` 被主服务外层分发器提前返回 404 的问题。
- 外层 HTTP 分发和内层反代现在都会识别 Codex 专用路径，并有回归测试防止再次漏配。

## v9.9.418 更新

### Codex 仅 URL/令牌接管与模块 2 热切换

- ⑧不再把 Codex 改成内部 `dao_proxy_hot / dao-codex-hot`；保留现有 Provider、模型、推理强度、上下文、notify 和其他 TOML 配置。
- 首次接管只把当前 Provider 的 `base_url` 与 `experimental_bearer_token` 指向独立本地 Responses 入口。正在运行的 Codex 需要重新加载这一次；之后切换无需重启。
- ②渠道配置的每个用户渠道新增“⑧Codex”按钮，可直接把该渠道设为 Codex 当前上游；⑧仍可精确选择渠道、真实模型、上游协议和推理强度。
- Codex 独立入口不占用③模型路由，也不受④模型反代的对外开关影响。同名模型在 Devin 与 Codex 可分别选择不同渠道。
- 从 9.9.415-417 升级时，如果检测到旧内部别名接管，会自动读取既有备份恢复原 Provider、模型和推理强度，再迁移到新入口。

## v9.9.417 更新

### 工作区变更自动捕获与审查

- ⑧会在扩展激活后自动建立工作区基线，并持续捕获 Codex、Devin 保存及外部程序产生的文件新增、修改和删除，无需手动点击开始。
- 面板集中显示文件状态、增删行统计和多根工作区来源；可打开 Devin/VS Code 原生绿红差异编辑器，并支持单文件或全部接受、回滚。
- 工作区文件夹发生变化时会自动重建捕获器；Unity 生成目录、依赖/构建目录、二进制文件和超大文件不会进入审查列表，`Assets/Library` 等真实项目资源仍会保留。
- 回滚会校验磁盘内容和未保存编辑器，发现捕获后又有新修改时会拒绝覆盖；捕获过程异步运行，不进入模型请求或任务生成链路。
- Codex 已写入磁盘的外部修改无法事后转换为 Devin ACP 原生 Diff Zone，因此本模块提供等价的插件审查与原生 diff 编辑器入口；“接受”表示保留当前文件并推进基线。

### v9.9.416：Codex 状态同步与账号/历史保护

- ⑧会自动显示 Codex 当前实际 Provider、模型、推理强度、协议和 Base URL；外部修改 `config.toml` 后约 3 秒内同步到 Devin 面板。
- 自动刷新只请求轻量状态，不重复探测渠道和模型，不影响任务生成速度。
- 状态接口不会返回 Codex Provider Token 或②渠道密钥正文。
- 插件只更新 `config.toml` 的模型路由字段，不操作 Codex 认证缓存、账号登录状态或历史会话存储，因此继续使用当前账号并保留原有聊天记录。

- 新增“⑧ Codex 热路由”，直接选择②渠道配置中的渠道和真实模型，以固定本地 Responses Provider（`dao_proxy_hot` / `dao-codex-hot`）接管 Codex。
- 首次接管会备份并更新 `~/.codex/config.toml`，因此需要重启 Codex 一次。此后渠道、模型、协议和推理强度由插件热切换，不需要再次重启 Codex。
- `grep_search` 匹配正文从 Devin 会话界面隐藏，但完整结果仍交给模型并保留在现有跨轮轨迹与缓存中。
- Fast Context 仍使用 Devin 原生 `code_search`；插件只规范 Windows 路径分隔符，不改写中文或英文查询正文。
- 对比旧版 `devin-remote-new-main` 后未发现更好的 OpenAI 缓存实现，继续保留当前 Responses 缓存键、连接亲和与 `dao-output://` 大输出持久化。

本文适用于 `dao-proxy-pro 9.9.407` 及以上版本，说明如何安装插件、使用项目提示词工作台、迁移数据，并启用独立协议中转站与自定义模型。

## 一、先说结论

在另一台电脑使用时，需要区分“插件功能”和“项目提示词数据”：

| 内容 | 是否包含在 VSIX 中 | 是否需要单独迁移 |
| --- | --- | --- |
| 项目提示词管理页面 | 是 | 否 |
| 严格替换注入逻辑 | 是 | 否 |
| 道Agent Pro 反代与路由功能 | 是 | 否 |
| 已保存的项目名称、分类、路径和提示词 | 否 | 是 |
| 当前处于注入状态的项目 | 否 | 到新电脑后重新点击“注入 Devin” |
| 外接模型渠道和 API Key | 否 | 需要时单独、安全迁移 |

因此：

1. 只安装 `dao-proxy-pro-9.9.407.vsix`，可以立即获得项目提示词注入、本地反代、协议中转站与自定义模型功能。
2. 如果还要带走当前电脑已经保存的项目提示词，需要额外复制 `project-prompts.json`。
3. 在新电脑安装并恢复数据后，必须进入项目提示词工作台，选择项目并再次点击“注入 Devin”。
4. 建议注入后新建一个 Devin/Cascade 对话，避免旧对话历史继续携带先前上下文。

## 一.1、本地中转快速使用

打开插件面板的“④ 模型反代”，勾选“启用模型反代”，复制页面显示的 Base URL 和 API Key。页面用单卡片切换协议，模型列表位于独立滚动区，自测下拉可直接验证四种接口：

- OpenAI Chat：`POST http://127.0.0.1:<端口>/v1/chat/completions`
- OpenAI Responses：`POST http://127.0.0.1:<端口>/v1/responses`
- Anthropic Messages：`POST http://127.0.0.1:<端口>/v1/messages`
- Gemini：`POST http://127.0.0.1:<端口>/v1beta/models/{model}:generateContent`
- Gemini 流式：`POST http://127.0.0.1:<端口>/v1beta/models/{model}:streamGenerateContent?alt=sse`

四种协议共用同一份模型路由、API Key、故障切换和用量记录。鉴权可使用 `Authorization: Bearer <API Key>`；Anthropic 兼容 `x-api-key`，Gemini 兼容 `x-goog-api-key`。如需公网调用，进入“⑤ 内网穿透”，同一条隧道会同时暴露上述端点。

### DeepSeek / MiMo 等模型转换为 Responses

进入“⑥ 协议中转站”，选择“使用②已有渠道”或“新建并同步到②”，填写上游真实模型并把“上游真实协议”设为 `OpenAI Chat`。在“转换后允许调用协议”勾选 `Responses`，设置一个不会与现有模型冲突的对外模型别名，然后点击“保存并同步”。插件会同时：

1. 在②渠道配置显示或创建对应渠道。
2. 在③模型路由显示“⑥ 协议中转同步路由”。
3. 在④模型反代模型列表显示带目标协议标记的对外模型别名。
4. 在⑥模块显示各协议端点、同步状态，并提供真实请求测试。

中转档案保存在 `%USERPROFILE%\.codeium\dao-byok\protocol-bridges.json`。API Key 仍只保存在原渠道配置中，不会复制进中转档案。

### ⑥协议转换测试与客户端配置

保存中转档案后，在⑥下方展开“协议转换全链路测试”：选择档案和目标协议，点击“测试所选协议”，或点击“测试档案全部协议”。测试会向插件当前本地端点发起真实请求，并检查 HTTP 状态与目标协议响应结构；因此它同时验证②渠道、③路由、⑥协议限制、④反代入口和上游模型。

继续展开“客户端配置”，选择同一中转档案及客户端，即可生成并复制 Codex、Claude Code、OpenCode、MiMoCode、OpenClaw 或 Hermes 配置。面板会显示该客户端要求的协议，并在档案未勾选对应协议时提示先修改档案。配置包含本机实际 Base URL、当前 API Key 和对外模型别名；复制到其他电脑时应在目标电脑重新安装插件、重新创建或迁移渠道配置，再以目标电脑面板生成的新地址和 Key 为准。

### ⑦自定义模型与思考强度

进入“⑦ 自定义模型”，选择②中已经接通的渠道，填写 Devin 模型 UID、显示名称和上游真实模型。插件会优先读取渠道 `/models` 返回的能力元数据；若上游未提供元数据，则按 GPT-5/o 系列、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi、MiMo 等模型族推断可用思考档位。用户只需从自动生成的“关闭/最小/低/中/高/超高/最大/自动”档位中选择，不需要手写协议参数。

保存后会原子同步到②渠道模型目录、③模型路由与 Devin 模型目录，并立即进入④模型反代和⑥协议中转的模型下拉与能力选择。④一键自测和⑥中转档案会按真实协议自动转换为 `reasoning_effort`、Responses `reasoning.effort`、Anthropic thinking budget 或 Gemini thinking budget。删除自定义模型时，如果仍被其他③路由或⑥中转档案引用，插件会拒绝删除并显示引用项，避免破坏现有链路。

从 v9.9.381 起，一个自定义模型可配置多个有序渠道。选择渠道与上游模型后点击“加入优先队列”，可继续加入其他渠道；拖动手柄或点击“置顶”调整顺序，第一项为首选，其余为备用。插件只在这份明确队列内自动切换：当前渠道失败才尝试下一项，成功后在同一 Cascade 会话保持该渠道以保护缓存；用户重新排序并保存后，下一次请求立即从新的第一项开始。模块 7 会显示最近实际使用的渠道；全部渠道都失败时 Devin 弹窗提示并提供打开设置入口。

从 v9.9.373 起，自定义模型采用缓存友好的会话状态机：上下文达到模型窗口约 78% 时一次性建立压缩检查点，保留约 40K 的近期工作集并落到约 50%；后续回合继续使用同一检查点，只追加新消息，因此不会再每轮滑动裁剪并破坏缓存前缀。旧工具输出会在检查点中归约，assistant/tool 调用与结果始终成对保留。终端命令拿到退出码或最终输出即视为完成，只有明确返回 `running + session id` 时才会调用一次 `command_status`。GPT-5.6 使用 Chat Completions 且携带工具时采用兼容的无思考参数模式；需要可调思考强度与工具并用时，优先选择支持 Responses 的中转档案。

从 v9.9.374 起，大型工具输出不再直接塞入每轮上下文，而是完整保存在 `%USERPROFILE%\.codeium\dao-byok\tool-output-cache`，模型看到稳定引用并可按需分块回读；缓存最多保留 7 天、512 个文件或 256MB。MCP 工具描述超过上下文 10% 时自动改为按需发现，核心代码工具不受影响。若某条自定义路由需要关闭，可在该路由 `contextStrategy` 中设置 `persistToolOutputs:false` 或 `deferMcpTools:false`。

从 v9.9.375 起，同一 Cascade 在客户端自动摘要、对话显示截断或点击“继续”后，如果新旧历史仍保留至少两条连续重合消息，插件会保留上一轮真实上游消息前缀，只追加本轮新消息，以最大限度延续提示缓存和执行状态；若检测到无重合的分支或全新任务，则不会错误拼接旧上下文。`Edit/multi_edit/Write` 等工具在发送编辑器前会校验必填路径与编辑内容，缺参调用由代理内部要求模型透明修正，避免连续出现“缺少必要文件路径参数”。第三方上游仍可能在相同缓存键和相同消息指纹下发生单次冷未命中，这属于上游缓存分片/淘汰，插件会通过稳定 `prompt_cache_key`、Keep-Alive 连接亲和与逐字节前缀续接将可控因素降到最低。

从 v9.9.376 起，当前活动的自定义/项目提示词保存在 `%USERPROFILE%\.codeium\dao-byok\custom-sp.json`，不再放在会随 VSIX 版本变化的扩展目录。首次启动会自动从最近的旧版本迁移 `_custom_sp.json`，因此升级插件或 Reload Window 后仍保持原项目提示词和严格替换状态；点击“恢复默认提示词”会保存清除标记，旧版本残留不会把已清除提示词重新恢复。

## 二、需要携带的文件

### 1. 插件安装包

当前安装包：

```text
dao-proxy-pro-9.9.407.vsix
```

本版本从 `9.9.382` 到 `9.9.407` 的功能、同步逻辑、协议修复和测试结果详见 [9.9.407 发布说明](docs/RELEASE_9.9.407.md)。

本机仓库中的完整路径：

```text
E:\windsurf-assistant-dao-proxy-pro-v9.9.353\plugins\dao-proxy-pro\dao-proxy-pro-9.9.407.vsix
```

复制到其他电脑时，可以把 VSIX 放在 U 盘、局域网共享目录或个人加密网盘中。

### 2. 项目提示词数据库

项目提示词保存在：

```text
C:\Users\当前用户名\.codeium\dao-byok\project-prompts.json
```

PowerShell 中对应路径为：

```powershell
$env:USERPROFILE\.codeium\dao-byok\project-prompts.json
```

该文件包含：

- 项目名称。
- 项目分类。
- 项目路径。
- 项目提示词正文。
- 最近选中的项目。

该文件不负责保存“当前活动注入状态”。插件升级、重装或迁移电脑后，需要重新选择项目并点击注入。

### 3. 可选的外接 API 配置

如果另一台电脑还需要使用相同的第三方模型渠道，可按需迁移：

```text
C:\Users\当前用户名\.codeium\dao-byok\配置.json
```

这个文件可能包含 API Key，属于敏感文件。不要上传到公开仓库、公开网盘、聊天群或截图中。

只使用官方 Devin 模型或不需要原渠道时，不必迁移该文件。

## 三、在当前电脑备份

以下示例把文件备份到 `D:\DaoPluginBackup`。

### 1. 创建备份目录

```powershell
$backupDir = "D:\DaoPluginBackup"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
```

### 2. 复制插件安装包

```powershell
Copy-Item `
  "E:\windsurf-assistant-dao-proxy-pro-v9.9.353\plugins\dao-proxy-pro\dao-proxy-pro-9.9.407.vsix" `
  $backupDir `
  -Force
```

### 3. 复制项目提示词

```powershell
$promptStore = Join-Path $env:USERPROFILE ".codeium\dao-byok\project-prompts.json"
Copy-Item $promptStore $backupDir -Force
```

### 4. 可选：备份外接 API 配置

```powershell
$providerConfig = Join-Path $env:USERPROFILE ".codeium\dao-byok\配置.json"
if (Test-Path $providerConfig) {
  Copy-Item $providerConfig $backupDir -Force
}
```

完成后，备份目录至少应包含：

```text
D:\DaoPluginBackup\
  dao-proxy-pro-9.9.407.vsix
  project-prompts.json
```

## 四、在另一台电脑安装插件

新电脑需要先安装 Devin Desktop。

### 方法一：命令行安装

假设安装包位于 `D:\DaoPluginBackup`：

```powershell
devin-desktop --install-extension "D:\DaoPluginBackup\dao-proxy-pro-9.9.407.vsix" --force
```

如果 `devin-desktop` 没有加入 PATH，可以使用 Devin Desktop 的完整可执行路径。

安装完成后验证版本：

```powershell
devin-desktop --list-extensions --show-versions | Select-String "dao-proxy-pro"
```

预期看到：

```text
dao-agi.dao-proxy-pro@9.9.407
```

### 方法二：从 Devin Desktop 界面安装

1. 打开 Devin Desktop。
2. 打开扩展管理页面。
3. 点击扩展页面右上角的更多操作菜单。
4. 选择“Install from VSIX”或“从 VSIX 安装”。
5. 选择 `dao-proxy-pro-9.9.407.vsix`。
6. 安装完成后执行 Reload Window，或完全退出并重新打开 Devin Desktop。

## 五、恢复项目提示词数据

建议先关闭 Devin Desktop，避免恢复过程中插件同时写入文件。

假设备份文件位于：

```text
D:\DaoPluginBackup\project-prompts.json
```

执行：

```powershell
$daoDataDir = Join-Path $env:USERPROFILE ".codeium\dao-byok"
New-Item -ItemType Directory -Force -Path $daoDataDir | Out-Null

Copy-Item `
  "D:\DaoPluginBackup\project-prompts.json" `
  (Join-Path $daoDataDir "project-prompts.json") `
  -Force
```

如果还要恢复外接 API 配置：

```powershell
Copy-Item `
  "D:\DaoPluginBackup\配置.json" `
  (Join-Path $daoDataDir "配置.json") `
  -Force
```

恢复后重新启动 Devin Desktop。

## 六、如何启动项目提示词注入页面

### 推荐方式：命令面板

1. 打开 Devin Desktop。
2. 按 `Ctrl+Shift+P` 打开命令面板。
3. 输入：

```text
道Agent Pro: 项目提示词注入
```

4. 点击该命令。
5. 插件会自动使用当前动态端口打开项目提示词工作台。

这是最稳定的启动方式，因为插件端口可能因用户、电脑或端口占用情况而变化。

### 不能直接打开 HTML 文件

不要直接双击或打开：

```text
plugins\dao-proxy-pro\vendor\bundled-origin\prompt_studio.html
```

直接打开会得到类似地址：

```text
file:///.../prompt_studio.html
```

页面中的 `/origin/project-prompts` 请求会被错误解析成文件协议请求，从而出现：

```text
Failed to fetch
```

项目提示词页面必须通过插件的本机 HTTP 服务打开，正确形式是：

```text
http://127.0.0.1:动态端口/origin/prompt-studio
```

不要长期保存某个固定端口链接，应优先使用命令面板启动。

## 七、如何新建并注入项目提示词

打开工作台后：

1. 点击“新建”。
2. 填写项目名称。
3. 填写分类，例如 `Unity 教育应用`、`Web 后端` 或 `个人项目`。
4. 填写项目路径。
5. 粘贴项目提示词。
6. 点击“保存并注入”，或先保存后点击“注入 Devin”。

注入成功后页面会显示：

```text
独占替换模式 · 下一条 Cascade 对话生效
```

当前版本的项目提示词采用严格替换模式：

- 模型的 System Prompt 只使用当前项目提示词。
- 不再拼接默认经藏提示词。
- 不再拼接官方系统提示词。
- 不再拼接工具保留块或工作区实时块。
- 对话消息和模型工具定义属于请求的其他结构，不等同于 System Prompt。

为了获得最干净、稳定的上下文，建议注入后新建一个 Devin/Cascade 对话，再开始处理该项目。

## 八、迁移后需要检查的项目路径

项目提示词可能在两个位置包含旧电脑路径：

1. 工作台中的“项目路径”字段。
2. 提示词正文中的“项目根目录”。

例如旧电脑是：

```text
E:\新增运行时状态机
```

新电脑如果改为：

```text
D:\Projects\EducationApp
```

需要同时修改工作台路径字段和提示词正文，保存后重新注入。

项目路径字段主要用于识别和备注；真正影响 Agent 判断的是提示词正文以及 Devin 当前打开的工作区。

## 九、验证项目提示词是否生效

### 1. 页面验证

项目左侧出现“已注入”，顶部显示项目名称，并显示：

```text
独占替换模式 · 下一条 Cascade 对话生效
```

### 2. 接口验证

插件会把当前端点写入：

```text
C:\Users\当前用户名\.codeium\dao-byok\endpoint.json
```

PowerShell 检查：

```powershell
$endpointPath = Join-Path $env:USERPROFILE ".codeium\dao-byok\endpoint.json"
$endpoint = Get-Content $endpointPath -Raw -Encoding UTF8 | ConvertFrom-Json

Invoke-RestMethod "$($endpoint.base)/origin/ping"
Invoke-RestMethod "$($endpoint.base)/origin/project-prompts"
Invoke-RestMethod "$($endpoint.base)/origin/custom_sp"
```

重点查看：

- `mode` 应为 `invert`。
- `activeProjectId` 应为当前项目 ID。
- `source` 应类似 `project:project-xxxx`。
- `keep_blocks` 应为 `false`。
- `chars` 应与项目提示词字数接近或一致。

### 3. 本源观照验证

发送一条新的 Devin/Cascade 消息后，打开道Agent Pro 的“本源观照”面板。

面板现在只显示模型实际收到的 System Prompt，不再展开全部对话历史和工具定义。显示字数应接近所选项目提示词字数。

旧的“真上游”捕获记录会保留到下一次真实请求；因此刚注入但尚未发送新消息时，可能暂时看到上一轮内容。

## 十、常见问题

### 1. 新电脑安装插件后项目列表为空

原因：VSIX 只包含功能，不包含用户的 `project-prompts.json`。

处理：把旧电脑的项目提示词文件复制到新电脑：

```text
C:\Users\新电脑用户名\.codeium\dao-byok\project-prompts.json
```

然后重启 Devin Desktop。

### 2. 项目存在，但顶部显示“默认提示词”

原因：项目只是保存了，还没有注入；或者插件升级后活动注入状态被清理。

处理：选择项目，点击“注入 Devin”。

### 3. 点击 HTML 后提示 Failed to fetch

原因：使用了 `file://` 打开方式。

处理：通过 `Ctrl+Shift+P` 执行“道Agent Pro: 项目提示词注入”。

### 4. 固定的 `127.0.0.1:8919` 地址失效

原因：端口是动态的，另一台电脑可能不是 `8919`。

处理：从命令面板启动，或者读取 `endpoint.json` 中的 `base`。

### 5. 注入后本源观照仍显示旧提示词

原因：面板展示的是最近一次真实模型请求，刚注入时还没有新请求。

处理：在 Devin 中新建对话或发送下一条消息，然后重新查看。

### 6. 插件升级后项目列表是否会丢失

正常不会。项目库保存在用户目录：

```text
%USERPROFILE%\.codeium\dao-byok\project-prompts.json
```

但升级后建议重新点击一次“注入 Devin”，确保活动项目恢复。

### 7. 卸载插件后项目提示词是否还在

通常仍在，因为用户数据不在扩展安装目录内。彻底删除时需要手工删除：

```text
%USERPROFILE%\.codeium\dao-byok\project-prompts.json
```

删除前建议备份。

## 十一、缓存命中建议

为了提高提示词缓存复用率：

- 每个项目使用一份长期稳定的项目提示词。
- 不要在项目提示词中加入当前时间、随机数、临时任务状态或每轮变化的内容。
- 不要频繁修改项目提示词的开头部分。
- 临时需求放在正常用户消息中，不要每次写回项目提示词。
- 切换项目后重新注入，并尽量新建对话。
- 不要把大量日志、完整文件内容或对话历史写入项目提示词。
- 项目提示词只保存架构、规范、固定路径和长期约束。

## 十二、安全建议

- 不要在项目提示词中保存密码、Token、Cookie 或 API Key。
- 不要公开分享包含内部项目路径、架构或业务规则的 `project-prompts.json`。
- 迁移 `配置.json` 时使用可信介质，并在完成后删除临时副本。
- 对外分享 VSIX 前，确认安装包中没有打入本地配置、项目提示词数据库或密钥。

## 十三、推荐迁移流程

最稳妥的完整顺序：

1. 在旧电脑备份 `dao-proxy-pro-9.9.407.vsix`。
2. 备份 `%USERPROFILE%\.codeium\dao-byok\project-prompts.json`。
3. 如有需要，安全备份 `配置.json`。
4. 在新电脑安装 Devin Desktop。
5. 安装 VSIX，并重载 Devin Desktop。
6. 关闭 Devin Desktop。
7. 恢复 `project-prompts.json` 和可选配置。
8. 重新打开 Devin Desktop。
9. 使用 `Ctrl+Shift+P` 启动“道Agent Pro: 项目提示词注入”。
10. 检查并修改新电脑上的项目路径。
11. 选择项目并点击“注入 Devin”。
12. 新建一个 Devin/Cascade 对话进行验证。

完成以上步骤后，另一台电脑即可使用相同的插件功能和项目提示词配置。

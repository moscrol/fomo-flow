# Dao 既有渠道与路由迁移设计

- 日期：2026-08-10
- 状态：已实现并于本机验收
- 范围：macOS Electron `接入渠道`、Desktop 私有配置与既有 Dao 配置的一次性迁移

## 1. 背景

既有 Dao 配置位于用户本机的 Dao 配置目录。当前检查显示它包含 25 个渠道、9 个自定义模型和 64 条路由；Desktop 私有配置只有 2 个渠道、1 个自定义模型和 3 条路由。Desktop 启动逻辑只会在目标配置不存在时复制既有配置，因此一旦 Desktop 已生成配置，后续不会补齐 Dao 中已经存在的渠道和路由。

用户选择完整迁移：渠道、自定义模型和原有路由顺序一起进入 Desktop。迁移必须保留用户已经规定的 provider/model priority，不得演变为自动同步或自动路由。

## 2. 目标

1. 在 `接入渠道` 提供直白的“从现有 Dao 导入”入口。
2. 导入前只展示安全预览：来源是否可用、新增数、覆盖数、保留数、渠道名称、模型数和路由数。
3. 用户二次确认后，一次性迁移既有 Dao 的渠道、自定义模型和完整 `daoRoutes`。
4. 迁移前生成 Desktop 配置私有备份；写入采用原子替换，失败时旧配置保持可用。
5. 迁移后复用既有配置监听热加载并刷新渠道、模型和路由展示。
6. 整个流程不探活、不调用 provider、不发送模型请求、不改变远程连接设置。

## 3. 非目标与边界

- 不建立源配置与 Desktop 配置之间的长期监听、软链接或双向同步。
- 不自动执行迁移；打开页面、预览和刷新均不得写配置。
- 不把 API Key、Authorization、完整配置、完整路径或其他凭据传给 renderer。
- 不自动重排、评分或优化 priority；迁移后的路由顺序必须与既有 Dao 配置一致。
- 不删除 Desktop 独有渠道或自定义模型。
- 不迁移 Desktop 的 gateway、端口、Taskboard、会话、任务、观测或远程连接状态。
- 不新增远程 endpoint；迁移只发生在 Electron main 的本机文件边界内。

## 4. 方案选择

采用“显式预览 + 私有备份 + 原子合并”的事务迁移。

未采用直接覆盖，因为它会丢失 Desktop 独有配置。未采用长期共用文件，因为 Web 与 App 会产生隐式耦合和双向配置风险。

## 5. 合并契约

迁移以既有 Dao 配置作为本次路由来源，以 Desktop 配置作为写入目标：

1. `gateway`：保留 Desktop 当前值。
2. `providers`：同名项采用既有 Dao 值；Desktop 独有项保留。这样迁入渠道的协议、地址、模型目录和凭据与当前 Dao 一致，但不会删除 App 独有渠道。
3. `customModels`：同名项采用既有 Dao 值，包含其中已经规定的渠道顺序；Desktop 独有项保留。
4. `daoRoutes`：采用既有 Dao 的完整对象，包括 `enabled`、`substituteEnabled`、`allowMcpTools` 和 `routes`。Desktop 的说明性元数据可以保留，但不得改变执行字段。
5. 其他顶层字段：默认保留 Desktop 值；本设计没有明确列出的源字段不得自动复制。

结果必须满足：既有 Dao 的每个 provider、自定义模型和 route 都可在合并结果中找到；同名配置与源一致；源路由对象深度一致，自定义模型 `channels` 顺序逐项一致；Desktop 独有 provider/customModel 仍存在；Desktop gateway 不变。

## 6. 模块设计

### 6.1 Main-only 迁移服务

新增独立的配置迁移服务，职责只有三项：读取并验证源/目标、生成安全预览、在确认后执行备份和原子写入。

服务不依赖 React，不返回原始配置。内部使用纯函数生成合并结果，文件适配层负责权限、备份和原子替换。

### 6.2 安全预览

预览返回固定字段：

- `available`
- `sourceLabel`，固定为“现有 Dao 配置”
- `providerNames`
- `providerCount`
- `customModelCount`
- `routeCount`
- `newProviderCount`
- `overwrittenProviderCount`
- `preservedDesktopProviderCount`
- `priorityPreserved: true`
- 固定风险说明与错误分类

预览不得包含来源路径、目标路径、base URL、API Key、Authorization、provider 原始对象、自定义模型原始对象或路由 payload。

### 6.3 IPC 边界

新增两个精确能力：

- `channelMigrationPreview()`：只读，不接收任意路径。
- `channelMigrationApply({ confirmationToken })`：只接受由当次预览生成、短时有效且仅存 main 内存的 token。

renderer 不能指定源文件、目标文件、合并字段或写入内容。apply 返回安全计数、备份是否成功和是否已触发热加载，不返回备份路径。

### 6.4 React 组件

`接入渠道` 页面新增独立迁移卡：

1. 初始状态说明 Desktop 使用私有配置，并提供“检查现有 Dao 配置”。
2. 预览成功后显示安全计数、渠道名称和“原路由优先级将按现有 Dao 保留”。
3. 用户点击“导入渠道与路由”后出现二次确认。
4. 确认前零写入；确认时只提交 preview token。
5. 成功后刷新渠道、模型和 overview；失败时保持预览并提供重试。

组件不显示或编辑密钥，不自动探活，不把迁移变成页面加载副作用。

## 7. 文件安全与审计

- 源配置只读。
- 目标目录权限保持 `0700`，配置、备份和审计文件保持 `0600`。
- 备份写入 Desktop 配置目录的私有备份子目录，名称使用受控时间戳，不接受 renderer 文件名。
- 写入使用同目录临时文件、`fsync`、关闭后 rename；失败清理临时文件。
- 审计只记录时间、计数、结果和不可逆散列，不记录配置内容、路径、渠道地址、密钥或原始错误。
- 错误必须经过现有 Desktop 脱敏器；renderer 只收到固定错误类别和小白文案。

## 8. 数据流

```text
用户点击检查
  → renderer 调用 preview IPC
  → main 读取固定源/目标
  → 验证并生成内存合并草稿 + 短时 token
  → renderer 只显示安全摘要

用户二次确认
  → renderer 提交 token
  → main 校验 token 与源/目标内容散列仍一致
  → 私有备份 Desktop 配置
  → 原子写入合并结果
  → 既有 fs.watch 热加载
  → renderer 刷新渠道、模型与路由摘要
```

如果源或目标在预览后变化，token 失效，apply 不写入并要求重新预览。

## 9. 错误处理

- 源不存在：显示“没有找到现有 Dao 配置”，不提供确认。
- JSON 无效或结构不完整：显示“现有配置无法安全读取”，不写入。
- 目标变化或 token 过期：显示“配置已变化，请重新检查”。
- 备份失败：终止迁移，不触碰目标。
- 原子写入失败：保留旧目标，返回可重试错误。
- 热加载未在限定时间反映新计数：文件迁移仍视为成功，但提示用户重启 App；不自动重启 runtime，以免中断 IDE 请求。

## 10. 测试与验收

### 10.1 纯合并测试

- 源同名 provider/customModel 覆盖目标。
- Desktop 独有 provider/customModel 保留。
- Desktop gateway 保持不变。
- 64 个路由对象与源完全一致，自定义模型 `channels` 数组顺序逐项一致。
- 未列入白名单的源顶层字段不进入结果。

### 10.2 文件与安全测试

- preview 零写入。
- apply 无 token、伪造 token、过期 token或配置漂移均零写入。
- 备份先于目标写入，权限正确。
- 写入失败保留旧目标并清理临时文件。
- preview/apply 响应不含 API Key、Authorization、base URL 或完整路径。

### 10.3 UI 与集成测试

- 页面加载不触发 preview 或 apply。
- 预览只显示安全摘要。
- 二次确认前没有写 IPC。
- 成功后刷新 providers/models/routes。
- 失败状态可重试，不把密钥或原始错误放进 DOM。

### 10.4 本机验收

1. 迁移前 Desktop 显示当前 2 个渠道、1 个自定义模型和 3 条路由。
2. 预览显示源侧 25 个渠道、9 个自定义模型和 64 条路由，以及实际冲突/保留计数。
3. 明确确认后，Desktop 能读取全部源渠道、模型和路由，原 priority 顺序逐项一致。
4. Desktop 独有配置仍存在，gateway 不变。
5. App 冷启动后结果仍在；配置备份存在且权限正确。
6. 迁移预览、IPC DTO、错误文案和审计中没有 API Key、Authorization、base URL、完整路径、确认 token 或完整配置。

## 11. 交付边界

本切片交付可复用迁移组件并在用户当前 Mac 上执行一次迁移。之后源 Dao 配置发生变化时，必须由用户再次进入 `接入渠道`、预览并确认；Dao Flow 不会后台自动同步。

## 12. 2026-08-10 本机验收结果

- 可见预览：25 个源渠道、9 个自定义模型、64 条路由；确认 token 未进入 DOM。
- 合并结果：26 个渠道（25 个源渠道 + 1 个 Desktop 独有渠道）、9 个自定义模型、64 条路由。
- 深度校验：源 provider、自定义模型及其 `channels` 顺序、全部非元数据 `daoRoutes` 与目标逐项一致；Desktop gateway 和 Desktop 独有渠道保持不变。
- 文件校验：目标、备份和审计为 `0600`，备份目录为 `0700`；审计只含白名单字段。
- 运行校验：配置热加载成功，App 冷启动后仍显示 26/9/64；没有触发渠道探活、provider 请求、priority 重排或后台同步。

## 13. 最终复审加固

- apply 使用服务级互斥；不同 preview token 也不能并发写同一目标。内存迁移草稿会清理过期项并限制最多 4 份。
- 备份后再次校验源/目标内容散列；最后一次校验返回后，默认目标写入在同一 Electron 主进程事件循环内同步完成 `open → fsync → rename`，不留下本进程配置写动作可插入的 await 窗口。
- 运行时从实际已加载配置维护不可逆 SHA-256 指纹。迁移成功判定同时要求 provider、自定义模型、路由精确计数与配置指纹一致；数量相同但内容仍旧时明确提示重启 App。
- 导入已经落盘但 React 刷新失败时，界面明确显示“配置已导入”，不会把刷新异常误报成导入失败或诱导重复写入。

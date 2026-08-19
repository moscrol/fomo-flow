# Dao 当前工作生命周期与 Taskboard 分层设计

- 日期：2026-08-10
- 状态：已实现并验收
- 范围：macOS Electron `当前工作`、本地运行历史与本机 Taskboard 协作

## 1. 背景

现有 `当前工作` 将 HUD 会话和任务接口投影成统一 Work Item，并按“需要我处理 / 正在进行 / 最近完成”分组。真实运行检查发现两个问题：

1. 已停止会话和大量终态任务继续占据工作桌，历史失败项淹没真实活跃工作。
2. 会话可能同时呈现 `active/requestInFlight` 与过旧活动时间，界面会出现“活跃但数百小时前”的矛盾状态。

Taskboard 与当前工作都采用 Work Item 视角，但职责不同。当前工作应表达实时运行事实，Taskboard 应保存有目标、负责人、验收条件和长期跟进价值的持久事项。两者需要显式连接，不应自动互相复制状态。

## 2. 目标

采用三层工作模型：

1. **当前工作：实时桌面。** 只展示正在运行、等待用户处理和与当前仓库相关的计划/验收事项。
2. **会话与任务历史：运行档案。** 保存已停止会话及成功、取消、失败的任务记录。
3. **Taskboard：持久工作账本。** 保存需要长期跟进的目标、责任、优先级与验收状态。

完成后，当前工作必须回答三个小白问题：

- 现在有什么正在运行？
- 有什么需要我处理？
- 有什么计划或验收事项仍未结束？

## 3. 非目标与安全边界

- 不自动把 session/task 创建为 Taskboard 事项。
- 不自动更新或关闭 Taskboard 事项。
- 不改变 provider/model 路由，不保存 route priority。
- 不新增远程执行、自动故障转移、MITM、隧道或外部连接能力。
- 不把 prompt、Authorization、密钥、完整路径、原始 session ID 或原始 job ID 写入 DOM、日志、Taskboard 或持久化账本。
- 不删除运行历史；“关闭”仅表示退出当前工作实时桌。

## 4. 三层职责

### 4.1 当前工作

当前工作改为三个区块：

1. **需要我处理**：尚未确认的失败、超时、连接中断、验证阻塞或状态过期。
2. **正在运行**：真实活跃会话、正在处理的请求、排队和运行中的任务。
3. **计划与验收**：本机 Taskboard 中属于当前仓库且状态为 `in_progress`、`blocked` 或 `in_review` 的事项。

移除“最近完成”区块。成功、停止、关闭和取消项立即退出当前工作。

### 4.2 会话与任务历史

- 已停止会话继续保留在“协作会话”。
- 成功、取消和失败任务继续保留在“任务进度”。
- 当前工作提供“查看历史”导航，但不复制历史详情。

### 4.3 Taskboard

- 当前工作只读展示当前项目的开放事项安全投影。
- 只有用户点击“加入任务板”、审阅安全预览并确认后，才创建新事项。
- 加入成功后，该运行异常视为已经转入持久跟进；加入失败则保持未处理状态。

## 5. 生命周期规则

### 5.1 会话

终态生命周期优先于布尔活跃标记。

| 输入事实                                                                | 当前工作结果           |
| ----------------------------------------------------------------------- | ---------------------- |
| lifecycle 为 `stopped`、`closed`、`completed` 或 `cancelled`            | 关闭并退出当前工作     |
| 非终态，`active` 或 `requestInFlight` 为真，且最近可信活动不超过 5 分钟 | 正在运行               |
| 非终态且活跃标记存在，但最近可信活动超过 5 分钟                         | 退出当前工作，历史保留 |
| 最近可信活动不超过 5 分钟且 verification blocking 或非终态 warning      | 需要我处理             |
| 既不活跃也无待处理事实                                                  | 退出当前工作，保留历史 |

终态会话即使曾经失败也不继续占据当前工作。需要长期追踪的事项应在关闭前显式加入 Taskboard。

### 5.2 任务

任务也按可信更新时间收口：所有状态统一以最后可信更新时间为准，超过 5 分钟没有更新即退出当前工作；失败、超时、断连和其他待处理事实只在五分钟窗口内显示，之后仅保留在任务历史。

| status                                              | 当前工作结果               |
| --------------------------------------------------- | -------------------------- |
| `queued`、`running`                                 | 正在运行                   |
| `failed`、`timed_out`、`detached`、`transport_lost` | 需要我处理                 |
| `succeeded`、`cancelled`                            | 退出当前工作，保留任务历史 |
| 其他终态                                            | 退出当前工作，保留任务历史 |

异常点击“我知道了”后退出当前工作。若同一运行来源产生新的失败结果，新的安全指纹不同，必须重新出现。

### 5.3 时间矛盾

投影层不得显示“正常活跃但数百小时前”。当活跃标记和时间戳冲突时：

- 保留安全事实，不猜测会话仍然健康。
- 将项目放入“需要我处理”。
- 文案固定为“状态可能已过期，请确认连接”。
- 同时修复上游活动时间选择，优先使用已验证的最近请求、工具或心跳时间；无法验证时不伪造当前时间。

## 6. 数据模型与组件

### 6.1 `workLifecycleProjection`

纯 TypeScript 模块，输入规范化 `CollaborationSession` / `CollaborationTask` 与当前时间，输出：

```ts
type LiveWorkDisposition =
  | { kind: "running"; reason: string }
  | { kind: "attention"; reason: string; fingerprint: string }
  | { kind: "closed"; reason: string };
```

模块不发请求、不写文件、不读取 raw payload。

### 6.2 `WorkAttentionLedger`

Electron 主进程本地账本，用于记录“我知道了”和“已加入任务板”。

- 只保存版本、脱敏 SHA-256 指纹、处理方式和时间。
- 不保存生成指纹的原始 session/job ID。
- 最多保存 2,000 条、保留 90 天，并使用原子写入。
- 新失败事实产生新指纹，因此不会被旧确认误隐藏。

### 6.3 `TaskboardLocalAdapter`

Electron 主进程中的本地边界：

- 只连接 Taskboard launcher-runtime 声明的 `127.0.0.1` 本机地址。
- challenge URL 和内部任务 UUID 只停留在主进程内存，不进入 renderer、DOM 或普通日志。
- 读取当前 workspace 映射项目。
- workspace 未映射项目时返回明确的只读空态并禁用创建，不猜测项目。
- 只投影 `identifier`、安全标题、状态、优先级和更新时间。
- 创建操作只接受经过白名单验证的安全字段。
- 不执行任意 `taskctl` 参数、shell 字符串或远程 URL。

连接发现顺序固定为：`CODEX_TASKBOARD_RUNTIME_FILE`、主进程私有配置中已选择的
`launcher-runtime.json`、开发态当前 runtime root 下的 `.taskboard-data/launcher-runtime.json`。
若三者均不可用，renderer 只能通过系统文件选择器显式选择一个
`.taskboard-data/launcher-runtime.json`；完整文件路径只保存在 Electron `userData` 私有配置中，
不返回 renderer。descriptor 必须是版本 1，URL 必须是无账号、无 query/hash 的 loopback HTTP
challenge URL。读取和创建都只能拼接固定 `/api/projects`、`/api/tasks` 路径。

Taskboard 的每次写入还必须有真实的 Codex conversation attribution。主进程只接受启动环境中
已有的 `CODEX_THREAD_ID`，不得伪造、复用旧事项的 thread ID 或把 runtime session/job ID 当作
conversation ID。缺少有效归属时仍可读取“计划与验收”，但“加入任务板”只展示安全草稿和
“需要从当前 Codex 任务发起”的说明，确认按钮禁用且写请求数保持为零。

### 6.4 Renderer 组件

- `CurrentWorkControlView`：组合实时 Work Item、处理账本和 Taskboard 投影。
- `TaskboardWorkPanel`：展示“计划与验收”及 Taskboard 离线空态。
- `PromoteWorkDialog`：展示将写入 Taskboard 的安全标题、摘要、优先级和验收文本；确认按钮是唯一创建入口。
- `WorkItemActionRow`：提供“我知道了”“加入任务板”“查看历史”。

## 7. 数据流

```text
/origin/hud/snapshot ─┐
                      ├─ 每 3 秒并行读取 ─ normalize ─ lifecycle projection
/origin/tasks ────────┘                                  │
                                                        ├─ 正在运行
WorkAttentionLedger ─────────────────────────────────────┤
                                                        └─ 需要我处理

TaskboardLocalAdapter ─ 每 15 秒 ─ safe projection ──────── 计划与验收
```

刷新继续使用序列号或取消机制，旧请求不得覆盖新选择或新状态。

## 8. 用户动作

### 8.1 我知道了

1. Renderer 发送当前安全 fingerprint。
2. 主进程验证格式并写入处理账本。
3. 当前异常退出“需要我处理”。
4. 不修改运行时任务、会话历史或 Taskboard。

### 8.2 加入任务板

1. 用户点击“加入任务板”。
2. Dialog 展示安全预览；创建前不发生任何写入。
3. 用户确认后，主进程验证本地 Taskboard 连接和字段白名单。
4. 创建事项成功后，记录安全 fingerprint 与 Taskboard `identifier`，并在“计划与验收”显示。
5. 创建失败时保留原异常并显示可恢复错误。

默认创建为 `todo`、`medium` 优先级。内容只包括：安全标题、来源类别、失败类别、建议验收文本和当前 workspace 的安全显示名。安全标题为空时固定使用“Dao Flow 异常需要处理”。不得包含原始 ID、命令、prompt、路径或鉴权内容。

若当前 App 进程没有真实 `CODEX_THREAD_ID`，步骤 3 不得执行网络写入；Dialog 保留安全预览并
直白提示需要从当前 Codex 任务发起。该约束优先于“创建便利性”，避免伪造 Taskboard 写入归属。

### 8.3 查看历史

沿用现有内存导航 token 进入“协作会话”或“任务进度”。token 不渲染、不持久化。

## 9. 错误处理

- HUD 失败：保留最近安全桌面并显示自动重试提示。
- Tasks 失败：使用 HUD 安全任务摘要降级。
- Taskboard 失败：只降级“计划与验收”，实时工作仍可用。
- 处理账本损坏：备份损坏文件并以空账本启动；不得因此隐藏异常。
- 创建 Taskboard 超时或冲突：不写入已处理状态；允许用户重试。
- 快速切换 Work Item：旧详情、旧 Taskboard 响应和旧错误不得覆盖当前选择。

## 10. UI 文案与排序

- 顶部统计：`运行中 N`、`待处理 N`、`计划事项 N`。
- 正在运行按最近可信活动时间降序。
- 需要处理按严重度、随后按最近失败时间降序。
- 计划与验收排序：`blocked`、`in_progress`、`in_review`，同状态按更新时间降序。
- 空态文案：
  - 需要我处理：`目前没有需要你处理的异常。`
  - 正在运行：`目前没有 Agent 正在运行。`
  - 计划与验收：`当前仓库没有进行中、阻塞或待验收事项。`

## 11. 测试与验收

### 11.1 纯模型

- 所有 terminal session 都输出 `closed`。
- `queued/running` 任务输出 `running`。
- `failed/timed_out/detached/transport_lost` 输出 `attention`。
- `succeeded/cancelled` 输出 `closed`。
- 活跃标记与过旧时间冲突输出 `attention`，不显示正常活跃。
- 指纹稳定、有界且不包含输入原文。

### 11.2 主进程与安全边界

- Taskboard 只接受精确 loopback launcher 地址和白名单操作。
- challenge token、内部 UUID、prompt、Authorization、完整路径、原始 session/job ID 不得进入返回投影、日志或创建正文。
- 未点击确认时，Taskboard 写请求数必须为零。
- 创建失败不写处理账本。
- 账本原子写、有界、损坏可恢复。

### 11.3 UI 与集成

- 当前工作不再渲染“最近完成”。
- 停止会话与成功/取消任务不出现在 DOM。
- 未处理异常可“我知道了”关闭；新异常重新出现。
- Taskboard 离线不影响实时区块。
- “加入任务板”必须经过预览和显式确认。
- 刷新并发、快速切换和组件卸载不会产生陈旧覆盖。

### 11.4 完整验收

- Desktop focused/full Vitest 通过。
- TypeScript typecheck、ESLint、Prettier/diff check 通过。
- Renderer build、Electron build、macOS arm64 打包通过。
- 根运行时测试通过。
- 实际 App 验证当前活跃会话置顶、终态项退出、Taskboard 离线可降级。

## 12. 实施切片

1. 生命周期纯模型和当前工作终态过滤。
2. 处理账本与“我知道了”。
3. Taskboard 本地只读投影与“计划与验收”。
4. 显式“加入任务板”安全预览和创建。
5. 文档、完整验收与 Taskboard 交接。

每个切片都必须保持用户现有 route priority，不覆盖工作区中无关的未提交改动。

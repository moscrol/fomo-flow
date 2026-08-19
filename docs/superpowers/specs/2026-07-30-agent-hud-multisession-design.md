# Agent HUD 多会话安全设计

## 目标

在不改变 Devin 现有编辑器布局的前提下，为 Dao 增加一个人类可见的 Agent HUD，并保留现有 Dao 路由状态项。最终状态栏使用两个相邻入口：

- `Dao`：显示当前会话的模型 UID 与实际渠道，并继续提供现有路由/模型快捷切换。
- `Agent`：显示当前会话的阶段、Todo 进度和验证状态，并提供会话选择、钉选、模式开关与详情入口。

状态必须按对话隔离。多会话并行而当前会话身份无法可靠确定时，HUD 只能显示安全汇总，不能用“最后更新的会话”冒充“当前会话”。

## 非目标

- 不修改 Devin 的 Editor Mode、侧栏、面板位置或聊天布局。
- 不篡改 Devin 内建扩展来读取未公开的当前聊天 UI 状态。
- 不把模型叙述当成测试、失败或完成状态的可信来源。
- 不在本期实现耗时、Token 预算、渠道健康分等 P2/P3 指标。
- 不让 `swe-1-6-fast` 冒充 Local 可选模型；Local 仍使用 UI 唯一可选的 `swe-1-6-slow`，Dao 在该 UID 内做多渠道路由。

## 已确认事实与约束

### 会话标识

真实的 `swe-1-6-slow` 出站请求已经确认包含原生 `cascadeId`。当前路由器把它规范化为 `dao:<cascadeId>`，并用这个 key 分开保存 `~/.codeium/dao-byok/agent-status/*.json`。

若极少数请求没有 `cascadeId`，现有代码会退回到 `modelUid + 首条用户消息` 的指纹。HUD 必须标记这种会话为 `derived` identity；原生 ID 和派生 ID 不得合并。

### UI 边界

Devin 底部状态栏属于整个窗口，不属于某个聊天页。公开的 VS Code 扩展 API 没有提供“当前选中的 Cascade/Local 对话已改变”事件。Dao 能在出站请求中可靠知道请求属于哪个会话，但不能可靠知道用户此刻在 UI 中点开的会话。

因此本设计采用“会话级状态 + 窗口级安全投影”：

1. 所有会话各自维护状态。
2. 窗口状态栏只投影一个明确会话，或投影多会话汇总。
3. 身份有歧义时绝不猜测。

### 两种“状态栏”

当前 `agent_status.js` 生成的是追加到 LLM messages 末尾的 `<agent_status>` 结构化快照，它是模型可见状态，不是人类可见 UI。

本设计新增的 Agent HUD 是 Devin 底部状态栏 UI。两者共享同一份可信会话状态和同一个会话模式，但渲染目标不同：

- 模型快照：完整、结构化、每轮替换。
- 人类 HUD：紧凑、可点击、仅显示关键结论。

## 方案选择

### 排除：最后写入者覆盖

每次任何会话更新都让状态栏切到该会话，代码最少，但并行 Agent 会不断抢占状态栏，造成闪烁和串台。该方案不采用。

### 排除：全局开关

全局 On/Off 无法让短问答保持安静、长任务自动获得状态支持，也无法满足每个对话独立控制。该方案不采用。

### 采用：会话级三态 + 安全投影

每个会话独立使用 `auto | on | off` 模式。窗口维护一个只负责展示的会话注册表；当无法唯一确定展示对象时显示汇总，用户可从 Agent HUD 中手动钉选某个会话。

## 状态模型

### 会话状态扩展

现有 agent status state 增加以下字段：

```js
{
  key: "dao:<cascadeId>",
  identity: {
    kind: "native" | "derived",
    id: "<cascadeId-or-fingerprint>"
  },
  mode: "auto" | "on" | "off",
  activation: {
    state: "dormant" | "active" | "disabled",
    reason: "manual" | "todo" | "tools" | "edit" | "test" |
            "terminal" | "failure" | "duration" | "off",
    activatedAt: 0
  },
  activity: {
    requestInFlight: false,
    lastRequestAt: 0,
    lastUpdateAt: 0
  }
}
```

原有 goal、phase、todos、execution、verification、conclusions、strategy 与 route 字段继续保留。

### 模式状态机

#### Auto（默认）

Auto 从 `dormant` 开始。Harness 仍以轻量方式观察消息与工具结果，但在休眠期：

- 不注入 `<agent_status>`。
- 不显示 Agent HUD 项。
- 不影响 Dao 路由项。

出现以下任一可信信号后转为 `active`：

- 检测到 Todo/计划且存在未完成项。
- 累计工具调用达到 3 次。
- 出现编辑、写文件、测试或终端类工具调用。
- 出现工具失败、测试失败或重复失败。
- 会话从创建到当前出站请求已持续 90 秒。

Auto 激活后在该会话存续期内保持 active，不因一次成功或 Todo 减少而反复隐藏，避免 UI 抖动。会话超过历史 TTL 后按现有清理规则重新开始。

#### On

立即转为 `active`，从下一次该会话出站请求开始注入模型快照并显示 HUD。手动 On 的原因记为 `manual`。

#### Off

转为 `disabled`：

- 不注入新的 `<agent_status>`。
- 出站前仍清理历史消息中残留的旧 `<agent_status>`，避免关闭后继续携带旧快照。
- 不在 Agent HUD 的 active 计数中出现。
- 保留最小会话身份与模式记录，便于再次切回 Auto/On。

Off 不关闭 Dao 路由、降级、路由状态或现有模型快捷切换。

### 向后兼容

当前配置中的 `agentStatus.enabled` 继续作为全局总开关：

- `enabled: false`：所有会话等价于 Off，且不创建 Agent HUD。
- `enabled: true` 或缺省：使用 `defaultMode`；缺省为 `auto`。

新增配置建议如下：

```json
{
  "daoRoutes": {
    "agentStatus": {
      "enabled": true,
      "defaultMode": "auto",
      "profile": "auto",
      "softRules": true,
      "auto": {
        "minToolCalls": 3,
        "activateAfterMs": 90000
      },
      "hud": {
        "enabled": true,
        "activeTtlMs": 120000,
        "staleTtlMs": 7200000
      }
    }
  }
}
```

非法 mode 或阈值回退到上述默认值，不使路由启动失败。

## 模块边界

遵循 `docs/CODE_STRUCTURE.md`，不继续把状态逻辑堆入 `extension.js` 或 `dao_router.js`。

### `core/agent_status.js`

继续拥有单会话可信状态、消息观察、模型快照渲染与持久化。新增职责：

- 解析会话模式和 Auto 激活状态。
- 在 Off 时清除旧快照但不注入新快照。
- 对外发出经过裁剪的状态更新事件。
- 使用临时文件 + rename 原子落盘，避免 HUD 或其他读者看到半截 JSON。

模块导出窄接口：

```js
prepareOutbound(opts)
setMode(key, mode)
summary(key)
listSummaries()
onDidUpdate(listener) -> disposable
clear(key)
```

`onDidUpdate` 只发布摘要，不把完整 messages 或敏感工具输出传给 UI。

### `core/dao_router.js`

继续只负责路由编排：

- 把规范化会话 key、模型 UID、实际 provider/upstream 传给 agent status。
- 通过 facade 暴露订阅、列表与 setMode，不实现 HUD 状态机。

### 新增 `core/agent_hud.js`

该模块拥有窗口级会话注册表与纯投影逻辑：

- 消费 agent status 摘要事件。
- 计算 active/stale 会话。
- 管理当前 pinned key。
- 生成 Dao 与 Agent 两个状态栏 item 的 view model。
- 生成 QuickPick 条目与详情 Markdown。

它不直接依赖全局 `vscode`；由 `extension.js` 注入时钟、workspaceState 与 UI 回调，便于单元测试。

建议接口：

```js
createAgentHudController({
  now,
  activeTtlMs,
  staleTtlMs,
  readPinnedKey,
  writePinnedKey
})

controller.update(summary)
controller.remove(key)
controller.setPinned(key | null)
controller.project() // { kind, dao, agent, sessions }
```

### `extension.js`

只承担 VS Code 适配：

- 创建第二个状态栏 item，Right alignment，紧邻现有 Dao item。
- 订阅 router facade 的状态摘要事件。
- 把 controller view model 写入 status item。
- 注册 `daopp.agentHud` 命令并显示 QuickPick/详情。
- 在 deactivate 时释放订阅和计时器。

## 窗口投影规则

### Active 与 stale

用于 HUD 的 active 是 UI 活跃度，不等同于任务 phase：

- `mode` 已激活。
- 且 request 正在进行，或 `lastUpdateAt` 距当前时间不超过 `activeTtlMs`（默认 2 分钟）。

超过 active TTL 的会话不进入汇总计数。超过 stale TTL（默认 2 小时）的摘要从窗口注册表移除。历史 JSON 的清理继续由 agent status TTL 管理。

### 投影优先级

1. pinned key 存在且未 stale：投影 pinned 会话。
2. 恰好一个 active 会话：投影该会话。
3. 两个及以上 active 会话：投影安全汇总。
4. 没有 active 会话：Agent item 隐藏，Dao item显示全局运行模式。

当 pinned 会话 stale 时自动解除钉选并重新计算，不能长期显示旧状态。

### 两个状态栏 item

单会话或 pinned 状态：

```text
Dao · slow→ay    Agent · exploring · 5/8 · test?
```

- Dao 文本使用该会话的 `modelUid → provider`；点击行为继续执行 `daopp.quickSwitch`。
- Agent 文本使用 phase、Todo 完成数和验证结论；点击执行 `daopp.agentHud`。

多会话安全汇总：

```text
Dao · multi    Agent · 2 active · 1 warn
```

汇总不展示任意一个会话的 phase、Todo 或 provider，防止用户误以为它属于当前聊天。

没有 active 会话：

```text
Dao Flow · invert
```

Agent item 隐藏。现有 Dao 快捷切换不消失。

### 告警语义

`warn` 只能来自代码维护事实：

- 最新测试状态为 failed。
- verification blocking 为 true。
- 同一工具/同一参数重复失败达到阈值。
- 存在当前未恢复的工具错误。

普通 open Todo、`test?` 或处于 exploring 不计为 warn。只有真实阻塞时才使用警告图标或警告背景，避免长期“满屏黄色”。

## 交互设计

### Agent HUD QuickPick

点击 Agent item 打开会话列表。每项显示：

- goal 的安全截断预览。
- workspace basename。
- Auto/On/Off 与激活原因。
- phase、Todo、验证状态。
- 最后更新时间。

选择会话后进入动作列表：

- Pin to HUD / Unpin。
- Set Auto。
- Set On。
- Set Off。
- Show details。

因为 Devin 不公开当前聊天事件，QuickPick 不使用“Current conversation”这一无法证明的标签。只有一个 recent 会话时可以把它排在第一位，但仍显示其 goal/workspace 供用户确认。

### Agent item 隐藏时的入口

Auto 休眠或所有会话 Off 时 Agent item 不占状态栏。此时仍可通过以下入口打开控制器：

- 命令面板：`Dao: Agent HUD`。
- 现有 Dao 快捷切换的附加入口：`Agent HUD…`。

因此短任务可以完全无 Agent 状态栏，同时不会失去手动开启能力。

## 并发与一致性

Node extension host 在单事件循环中处理摘要更新。每个摘要带 `key` 与单调递增 `version`：

- controller 只接受 version 更高或更新时间更新的同 key 摘要。
- A 会话更新只能替换注册表中的 A，不能覆盖 B。
- 多会话投影一次性从注册表快照计算，不能逐字段拼接不同会话。
- UI 更新合并到一个短 debounce（建议 50–100ms），减少工具密集任务造成的重绘，但不改变状态语义。

持久化采用同目录临时文件写入并 `rename`，失败时保留上一份完整状态；落盘失败只记诊断，不中断模型路由。

## 错误处理

- 缺失 key：使用现有 derived identity；UI tooltip 明确标记 derived，不与 native 合并。
- 状态文件损坏：忽略该文件，创建空状态并记录诊断；不能让扩展激活失败。
- 状态订阅异常：隔离 listener 异常，路由仍继续。
- HUD 渲染异常：隐藏 Agent item并保留 Dao item与路由。
- mode 更新失败：QuickPick 给出错误提示，保留旧 mode。
- 配置热更新：新阈值用于后续判断；全局 disabled 立即隐藏/停注入；重新 enabled 不强制把 per-session Off 改回 Auto。

## 隐私与信息最小化

- 状态栏正文不显示完整 goal、错误正文、绝对路径或提示词。
- tooltip/QuickPick 只显示截断 goal、workspace basename 与结构化结论。
- 完整状态仍只在用户本机 `~/.codeium/dao-byok/agent-status/` 落盘。
- UI 事件不得携带完整 messages、工具输出或密钥。

## 测试方案

### Agent status 单元测试

- Auto 短问答在阈值前不注入、不激活。
- Todo、第三次工具调用、编辑、测试、终端、失败和 90 秒分别可激活 Auto。
- Auto 激活后不因下一轮无工具而回到 dormant。
- On 从首轮注入。
- Off 不注入，并清除历史 `<agent_status>`。
- A/B 会话交错更新时状态与 mode 完全隔离。
- 原子保存失败不破坏旧文件。

### HUD controller 单元测试

- 0 active：Agent hidden，Dao 显示全局 mode。
- 1 active：两个 item 投影同一个 key。
- 2 active：只显示 multi/汇总，不泄漏任一会话详情。
- pinned：两个 item 都投影 pinned key。
- pinned stale：自动解除并回到普通规则。
- 旧 version 更新不能覆盖新摘要。
- warn 只由结构化失败事实产生。

### Extension 集成测试

- 第二状态栏 item 的 command、priority、show/hide 正确。
- Dao item 原有 `daopp.quickSwitch` 行为不回归。
- Agent hidden 时命令面板和 Dao QuickPick 仍能打开控制器。
- dispose/deactivate 不残留 timer 或 listener。
- 配置热更新能切换 enabled/defaultMode/TTL。

### 真机验收

1. 同步源码到已安装扩展并 Reload Window。
2. 新建短问答，确认 Agent item 不出现，Dao item保留。
3. 在同一对话触发 3 次工具调用，确认 Agent item 自动出现。
4. 创建第二个并行长任务，确认 HUD 变成 `multi + N active`，不在两个详情之间闪烁。
5. 点击 Agent item，选择并 pin 某会话，确认 Dao 与 Agent 两项同时跟随该 key。
6. 将另一会话设为 Off，确认不注入、不计 active，路由仍正常。
7. 将会话改为 On，确认下一轮立即注入并恢复 HUD。
8. 注入一次真实测试失败，确认 warn；随后真实测试通过，确认阻塞告警解除。
9. 检查 agent-status 文件均为完整 JSON，无临时文件残留。

## 完成条件

- 每个会话按 native cascadeId 独立维护 mode、状态与路由事实。
- Auto/On/Off 对模型快照和人类 HUD 的行为符合状态机。
- 短任务默认不显示、不注入；复杂任务能按可信阈值自动激活。
- 多会话无 pin 时只显示安全汇总，不发生 last-writer 串台或闪烁。
- pinned 时 Dao 与 Agent 两个 item 始终来自同一个会话 key。
- 现有 Dao 快捷切换、Local slow 路由与自动降级不回归。
- 单元测试、集成测试和真机验收全部通过。
- 不覆盖工作树中与本任务无关的既有改动。

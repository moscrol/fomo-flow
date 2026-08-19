# Buzz-inspired Dao ACP 活动流设计

## 背景

Buzz 的 Activity 设计把代理运行过程从原始日志转换成可读的
`verb · object · outcome` 事件，并允许在语义摘要与原始事件之间切换。
Dao 已经拥有安全的 `/origin/hud/snapshot` 投影和原生 ACP 会话工作台，本切片
只吸收这一层产品与信息架构，不引入 Buzz 的 Rust/Nostr relay、桌面 shell 或
执行器。

## 目标

1. 将现有会话请求投影成稳定、可排序、可筛选的语义活动项。
2. 在会话详情中提供结果优先的活动时间线：生命周期、路由/工具、进度与结果。
3. 连续同类事件合并，失败与超时突出显示，原始安全字段可按需展开。
4. 只消费现有安全投影；旧数据缺字段时显示未知，不构造虚假的成功指标。

## 非目标

- 不复制 Buzz 的 Nostr 协议、relay、远程 agent、Rust ACP harness 或 Tauri 壳。
- 不在本切片新增任务调度、取消、文件写入、prompt 展示或密钥读取。
- 不复用 Dao Flow 页面；活动流作为 ACP 原生组件接入现有工作台。

## 数据契约

`CollaborationActivityItem` 是 renderer-owned 的只读模型：

```text
id, at, sessionId, turnId, kind,
verb, object, outcome, tone, detail,
repeatCount, raw
```

`kind` 只允许 `lifecycle | route | tool | progress | result | unknown`；
`tone` 只允许 `good | warn | bad | muted | brand`。所有文本经过裁剪、空白归一
和凭据遮罩；`raw` 仅保留已经从 HUD 投影出来的安全字段。

## 归一化与聚合

- 从 `recentRequests` 生成请求/路由/结果事件；从选中 session 生成当前生命周期、
  phase、todo 和 warning 事件。
- 以 `sessionId + kind + verb + object + outcome` 作为重复事件的合并键；合并时只
  增加 `repeatCount` 和最新时间。
- 按时间倒序，最多 80 项；同一 session 外的请求不进入详情时间线。
- 对未知或字段不完整的请求保留 `unknown` 项，避免把缺失数据误标成成功。

## 交互

- 详情区显示四个筛选：全部、生命周期、路由/工具、结果。
- 每项以“动作、对象、结果、相对时间”呈现；重复事件显示 `×N`。
- `查看原始事件` 使用原生 `<details>`，默认折叠；不展示 prompt、token、完整路径
  或认证头。
- 轮询沿用工作台现有 3 秒节奏；离线/错误仍显示已有数据和错误状态。

## 验收

1. 模型测试覆盖事件分类、凭据/路径遮罩、重复事件合并、上限和未知状态。
2. ACP 工作台测试覆盖活动流、筛选、重复计数、raw 展开与空态。
3. `npm --prefix desktop run typecheck`、`lint`、`test`、`build` 全部通过。
4. `git diff --check` 通过，且只提交本切片文件。

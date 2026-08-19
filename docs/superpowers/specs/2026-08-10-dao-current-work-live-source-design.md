# Dao Current Work Live Source Design

- 日期：2026-08-10
- 状态：已批准实施
- 范围：Electron 主进程观测选择与“当前工作”只读展示

## 问题

“当前工作”同时读取 `/origin/hud/snapshot` 与 `/origin/tasks`。HUD 已通过主进程选择真实有活动的本机 Dao 运行时，但 tasks 仍固定读取 App 自有运行时，导致同一页面使用两套数据源。页面随后只展示通过生命周期筛选的项目，不说明原始观测量、数据源和被终态规则排除的数量，因此真实结果为空时看起来像“没有监控”。

## 目标

1. HUD 和 tasks 必须来自同一次策略选择出的真实本机观测源。
2. `/origin/tasks` 保持只读；本机 bearer key 只在 Electron 主进程内获取和使用。
3. “当前工作”显示安全观测摘要：数据源端口、观测到的会话/任务数、正在运行/待处理数、因已结束而退出实时桌的数量。
4. 空态必须区分“成功观测但当前没有运行工作”与“数据源不可用”。
5. 保持现有生命周期规则：终态立即退出实时桌，历史不删除。

## 数据流

```text
Desktop runtime + ~/.codeium descriptor
        -> health + HUD evidence ranking
        -> selected loopback source
        -> HUD snapshot
        -> authenticated GET /origin/tasks
        -> renderer safe normalization
        -> live-work projection + observation summary
```

## 安全边界

- 不允许 renderer 提供任意 URL、query、Authorization 或路径。
- `/origin/tasks` 只接受精确 GET，无 query、无 body。
- bearer key 不进入 renderer、DOM、日志或错误消息。
- 原始 session/job ID 仅作为内存导航 token，不渲染、不持久化。
- 不新增写操作、远程连接、自动 provider/model 切换或 priority 保存。

## UI

顶部增加“观测状态”行：`数据源 本机 :port`、`观测到 N 个会话`、`N 个长任务`、`N 个已退出实时桌`。当运行中和待处理均为零时，显示“观测正常；当前没有 Agent 正在运行。已结束内容可在历史页查看。”；读取失败时保留旧桌面并显示自动重试错误。

## 验收

- 观测源测试证明选中 8955 后 `/origin/tasks` 也请求 8955，且携带只存在主进程的 bearer。
- 控制面白名单拒绝 `/origin/tasks?token=...`。
- CurrentWork 测试证明终态会话/任务不出现在实时列表，但计入“已退出实时桌”。
- 聚焦测试、Desktop 全量测试、typecheck、build、package 通过；安装 App 后页面可见观测摘要。

# Dao 当前模型实时观测设计

- 日期：2026-08-11
- 状态：用户已批准按最优路径持续推进
- 范围：Dao Flow Desktop 主进程与原生 HUD/当前工作展示

## 目标

Dao Flow App 必须在“当前工作”和 HUD 会话列表中直接显示正在使用的上游模型、渠道与路由名；Devin 工作进程重启导致 HUD 内存状态断档时，App 仍能从固定本机状态目录恢复最近五分钟的路由事实。

## 方案

1. Electron 主进程以只读方式扫描固定目录 `~/.codeium/dao-byok/agent-status`，限制文件数量和单文件大小，只接收 JSON 状态文件。
2. 主进程只投影生命周期、阶段和 `modelUid/provider/upstreamModel/provisional`；原始会话 ID 先做 SHA-256 截断，goal、prompt、Authorization、完整路径与环境字段不进入 renderer。
3. 状态文件投影只保留最近五分钟且未终止的会话，再与现有本地 HUD 快照按安全哈希 ID 合并。已有 HUD 的缓存、验证和遥测事实继续保留，更新的文件路由事实优先。
4. 当前工作卡片直接展示“正在使用的模型”，并同时展示渠道和路由名。HUD 会话卡片和详情使用同一组直白中文标签。

## 边界

- 不修改 Devin 插件。
- 不改变 provider/model priority，不自动切换或保存路由。
- 不新增远程能力，不读取 renderer 提供的路径。
- 超过五分钟无可信活动的状态文件会话不进入实时桌，历史文件不删除。

## 验收

- 用真实状态结构的测试夹具能投影当前模型，且 DOM 中不存在原始 ID、goal、Authorization 或完整路径。
- HUD 快照暂时没有该会话时，固定目录中的新鲜会话仍可进入 App；同 ID 时不丢失 HUD 缓存事实。
- 当前工作与 HUD 无需进入二级详情即可看见“正在使用的模型”。
- focused tests、Desktop 全量测试、typecheck、lint、build、macOS 打包安装和本机 API/界面验收通过。

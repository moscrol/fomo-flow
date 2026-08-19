# Terra 探活修复与 P0 验收设计

## 目标

修复 `swe_route_guard` 对 OpenAI-compatible provider 的探活 URL 解析，使 terra 使用配置声明的真实 completion endpoint；随后完成 Fast 渠道降级的真链路验收。

本次不改变 SWE 路由优先级、不新增渠道，也不扩展状态栏功能。

## 已确认现状

- Dao `:8955` 健康，运行模式为 `invert`。
- Devin Local 默认模型已固定为 `swe-1-6-fast`。
- Fast 主链路已实测通过：`swe-1-6-fast → glm/glm-5.2`。
- 状态栏已有真实 `agent_status inject` 日志；模块验收确认快照位于 messages 末尾且多轮只保留一个。
- terra 配置为 `baseUrl=https://kfcoding.codes`、`completionPath=/v1/chat/completions`。
- 当前守护忽略 `completionPath`，把探活 URL 拼成 `/chat/completions`，返回 `200 + HTML`。

## 方案

### Endpoint 解析

为守护增加一个小型、纯函数式的 endpoint 解析边界：

1. 若 `baseUrl` 已是完整的 `/chat/completions` endpoint，直接使用。
2. 否则若 provider 声明 `completionPath`，将其与去除末尾斜杠的 `baseUrl` 拼接。
3. 否则 OpenAI-compatible provider 缺省使用 `/v1/chat/completions`。
4. Anthropic 逻辑保持现状，本次不改。

`probeProvider` 只负责读取 provider、选择协议并发探活请求；URL 细节由解析函数负责，便于回归测试。

## 数据流

`配置.json provider` → `swe_route_guard.probeProvider` → endpoint 解析 → 真实 chat 请求 → 响应分类 → `lastProbe` → desired/degraded 路由模板。

探活成功只让守护使用既有 desired 模板；探活失败继续使用既有 degraded 模板。Fast 的 `glmOnlyUids` 保护逻辑不变。

## 错误处理

- provider 缺失、关闭、无 key、无 base URL 时沿用当前明确错误原因。
- 非 2xx、HTML、非 JSON、非 chat shape、超时和网络错误继续由现有分类器处理。
- endpoint 解析不得吞掉探活错误，也不得把失败误判为成功。

## 测试与验收

### 回归测试

- `baseUrl=https://kfcoding.codes` 且 `completionPath=/v1/chat/completions` 时，请求路径必须是 `/v1/chat/completions`。
- `baseUrl` 已包含完整 `/v1/chat/completions` 时不得重复拼接。
- 未声明 `completionPath` 时缺省路径必须是 `/v1/chat/completions`。

测试先在旧实现上失败，再在修复后通过。

### 运行时验收

1. 将源码修复同步到已安装扩展。
2. Reload Window，使新的 JS 进入运行实例。
3. 等待或触发 terra 探活，确认不再出现 `http-200-html-not-api`；若 API 自身拒绝，则保留真实的权限或协议错误。
4. 临时让 Fast 首选 glm 失败，发送最小请求，确认自动切换到下一健康渠道。
5. 立即恢复配置，确认运行时 Fast 路由仍为预期顺序。

## 完成条件

- endpoint 回归测试全部通过。
- terra 探活访问配置声明的 API 路径。
- Fast 主链路和至少一次自动降级均有运行时证据。
- 临时故障注入全部恢复，磁盘配置与运行时路由一致。
- 不触碰工作树中与本任务无关的既有改动。

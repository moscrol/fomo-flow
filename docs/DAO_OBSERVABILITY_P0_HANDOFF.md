# Dao Observability P0 Handoff

更新时间：2026-08-01（Asia/Taipei）

## 交接结论

当前工作区已经有一条可运行的双源 Observability 读路径，但 Dao Observability P0 尚未完成。现状可以安全地继续开发，不能直接宣布完成或部署为最终 P0。

## 当前工作区

- 仓库：`/Users/a77/dao-proxy-pro`
- 分支：`codex/prompt-cache-optimization`
- HEAD：`a7d1c66 fix: keep codex routed through dao after restart`
- 工作区是脏的，包含用户既有未提交修改；不要 `git reset --hard`、不要整体 `git add -A`。
- 当前未提交改动覆盖 HUD、Codex hot route、反代/路由器、TTFT、扩展入口和测试等多个文件。交接者必须先用 `git diff -- <file>` 区分既有改动与自己的 hunks。

## 已确认通过的证据

以下命令在交接前通过：

```bash
node test/observability-store.test.js
node test/web-hud-projection.test.js
node test/web-hud-service.test.js
node test/web-hud-http.test.js
node test/web-hud-client.test.js
```

现有仓库此前的 Codex hot route、Codex hot endpoint、TTFT、prompt-cache、router 和 Agent HUD 自测也已通过；重新修改相关文件后必须重跑完整回归，不要只依赖这份 handoff。

## 已落地的 Observability 产物

### `core/observability_store.js`

当前模块提供：

- `createObservabilityStore({ now })`
  - `recordNetworkSample(sample)`：记录 Dao 网络请求样本；仅允许 `codex` / `devin` surface。
  - `recordLifecycleSession(summary)`：记录 Codex/Devin 生命周期摘要；Codex key 要求 `codex:<24 hex>`。
  - `getMetric(path)`：返回 `{ value, confidence, source, observedAt }`。
  - `snapshot()`：返回全局 routed 指标、session 摘要、网络样本环和 health。
  - `health()`：返回 `off` / `live` / `stale` 及拒绝计数。
- `buildObservabilityFromHudInputs(input)`：从现有 usage request ring 和 Codex summaries 构建一次性快照；重复 HUD polling 不累加同一批 request。
- 公共快照不复制 raw thread id、cache key、完整路径或内容字段。
- 网络 usage 拥有 routed global totals；lifecycle cache 不加入 global totals，避免双计数。
- 容量有界：session 64、网络样本 200、HUD 暴露最近 20 条网络样本。

### 已接入读路径

- `core/web_hud_service.js`：默认从 usage + Codex summaries 生成 `input.observability`；也支持显式 `readers.observability`，失败会隔离为 warning。
- `vendor/bundled-origin/source.js`：Web HUD live service 显式调用 `buildObservabilityFromHudInputs`。
- `core/web_hud_projection.js`：已投影 `observability`，保留旧 HUD 字段兼容性。

## P0 覆盖状态

| P0 要求 | 状态 | 说明 |
|---|---|---|
| 统一 session / turn / request / attempt ID | 部分完成 | Codex lifecycle key 已做 hash；网络样本尚未形成完整 request/attempt 链，缺 turn-to-request 精确 join。 |
| observed / reported / estimated / unknown | 部分完成 | store 已有 confidence 枚举和 unknown metric；四级语义尚未贯穿所有旧 usage、成本和 HUD 字段。 |
| 会话级成本 | 未完成 | 现有 provider usage 有部分 cost 能力，但 store/HUD 尚未按 session 聚合并明确未知价格语义。 |
| 缓存节省 | 部分完成 | 已有 cache input/cached/hitRate；尚未在可信价格下计算 session/global savings，未知价格不能显示为 0。 |
| 重试浪费 | 未完成 | request samples 有 attemptCount/部分 retry timing，但没有独立 committed-vs-wasted attempt 聚合。 |
| cache miss 原因 / 前缀稳定度 | 未完成 | 旧 projection 有 stable-prefix 字段；尚未形成原因枚举、稳定度指标和可信度标签。 |
| 完整延迟瀑布 / 数据新鲜度 | 部分完成 | TTFT、duration、Dao/upstream/retry 分段和 health stale 已存在；尚未统一到所有 request/attempt 记录和 HUD 详情。 |
| Agent 自报状态 vs 硬验收状态 | 未完成 | 现有 Agent verification 可显示测试事实，但没有独立 acceptance gate / hard-state 契约。 |
| 高风险工具、敏感数据、越界访问审计 | 未完成 | 现有 `/origin/ea/audit` 是配置动作审计；P0 需要工具/敏感数据/越界事件的结构化、安全脱敏审计。 |
| HUD 总览、会话详情、告警、归档 | 部分完成 | 总览/会话详情/新鲜度已有基础；告警与归档视图未接入 Observability store，需补 HTTP/SSE/UI。 |
| Codex/Devin 实机验收 | 未完成 | 尚未做本轮最终实机链路、双会话隔离、Cockpit 故障、恢复/漂移和隐私边界验收。 |

## 下一位执行顺序

1. **先锁数据契约，不扩散 UI**
   - 为 `sessionId`, `turnId`, `requestId`, `attemptId` 定义格式和生成责任。
   - 每个 metric 固定 `{ value, confidence, source, observedAt }`；缺失值统一 `value: null, confidence: "unknown"`。
   - 明确事实所有权：网络拥有 request/attempt/TTFT/HTTP/重试；lifecycle 拥有 session/turn/tool/compaction/硬验收。

2. **补网络观测链**
   - 在 Codex hot request 入口生成 request ID。
   - 每个上游 channel attempt 生成 attempt ID；只有 committed attempt 计入 routed usage。
   - 将 retry failure、wasted tokens、retry overhead、cache miss reason 以脱敏结构写入 bounded sample。

3. **补价格、成本与缓存节省**
   - 价格缺失时成本和 savings 必须为 `null + unknown`，不能显示 0。
   - 显式价格存在时，分别计算 `grossCost`, `cachedCost`, `cacheSavings`, `retryWasteCost`，并按 session/global 聚合。
   - 缓存节省必须基于 observed cached tokens；估算值不能伪装成 observed。

4. **补硬验收和安全事件**
   - 自报字段单独命名为 `reportedStatus`。
   - 硬验收只接受测试运行、退出码、部署探针、路由探针等可验证事实；`reportedStatus=complete` 不得单独使任务变绿。
   - 新增 `securityEvents`：高风险工具、敏感数据触达、越界访问、拒绝/阻断结果；只留类别、工具名、判定、脱敏 hash、时间和 ID。

5. **补告警与归档**
   - 告警至少覆盖 stale、schema drift、route degraded、cost unknown/over-budget、security event、hard acceptance failed。
   - 归档保留最近 15 分钟 session/request/alert 的有界摘要；不能归档 raw prompt、tool args/output、凭据、cache key 或完整路径。
   - 为 `/origin/hud/snapshot`、`/origin/hud/events` 增加告警/归档字段，并保持 loopback、CSP、no-store、nosniff。

6. **最后做实机验收**
   - Codex 正常流式 turn、tool turn、compact turn。
   - 两个 Codex session + 一个 Devin session 并发，确认无跨 session cache/status 污染。
   - 停止 Cockpit，确认 degraded 且无静默 fallback；恢复配置并验证 drift fail-closed。
   - 检查 HUD serialized snapshot 不含 raw thread/cache key/prompt/tool payload/path/credential。

## 推荐验证命令

```bash
# 聚焦
node test/observability-store.test.js
node test/web-hud-projection.test.js
node test/web-hud-service.test.js
node test/web-hud-http.test.js
node test/web-hud-client.test.js

# 现有相关回归
node test/codex-hot-route.test.js
node test/codex-hot-endpoint.test.js
node test/ttft-metrics.test.js
node test/prompt-cache-router.test.js
node test/cache-resilience.test.js

# 修改 vendor / bundled origin 后，再跑项目完整测试入口
npm test
```

## 安全与工作区注意事项

- 不要把 Codex auth cache、rollout 原文、prompt/response、tool args/output、raw cache key 或完整 workspace path 写入 HUD、日志、测试快照或 handoff。
- 不要把 `vendor/bundled-origin/source.js`、`vendor/外接api/core/dao_router.js`、`vendor/外接api/core/revproxy.js` 的整文件加入 staging；它们本来就有脏改动。
- 每次提交前运行：

```bash
git diff -- <本次触碰的文件>
git diff --cached --check
git diff --cached --stat
```

- 本 handoff 只记录状态，不代表 P0 完成；完成条件必须由测试、HTTP 快照和 Codex/Devin 实机证据共同证明。

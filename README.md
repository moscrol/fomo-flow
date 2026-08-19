# FOMO FLOW · Model Gateway

**Local multi-provider model gateway for Devin / Windsurf / VS Code.**

Route any model request through your own BYOK channels. Fail over automatically. Score channels by cost, latency, and health. Self-heal when upstream dies. Keep Anthropic prompt cache warm across retries.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-9.9.424-green.svg)](CHANGELOG.md)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC.svg)](https://code.visualstudio.com/)
[![Tests](https://img.shields.io/badge/tests-100%2B%20feature%20%7C%20358%20core-brightgreen.svg)](test/)

---

## 中文摘要

**FOMO FLOW · 本地多渠道模型网关**，面向 Devin / Windsurf / VS Code。

把 IDE 里的一次模型请求，路由到你自己的 BYOK 渠道：自动故障转移、按成本/延迟/健康度打分选路、上游挂了后周期探活自愈，并尽量保住 Anthropic prompt cache 与会话亲和。

适合同时接 Claude / GPT / Grok / GLM / DeepSeek 等多家接口的人。常见痛点它这样处理：

| 痛点 | FOMO FLOW 做法 |
| --- | --- |
| 某个渠道 503 / 429 / TLS 断连 | 熔断降敏 + 周期探活 + 亲和恢复 |
| 总是打到贵渠道 | 成本感知评分 + 健康/延迟排序 |
| 故障切换后 Claude 缓存丢失 | 会话亲和暂存/恢复 + beta 头合并 |
| 本地 grep / 搜索反复打 | 只读工具结果短缓存（写入类工具永不缓存） |
| OpenAI / Anthropic / Gemini 协议混用 | 原生适配 + 本地反代入口 |
| 改完不知道有没有生效 | 路由诊断日志 + 缓存命中率可观测 |

一句话：**不是只会转发的本地代理，而是会择优、会熔断、会自愈的路由层。**

## macOS Desktop

[`desktop/`](desktop/README.md) 提供 Apple Silicon 的独立 Electron 交付：自己启动 FOMO FLOW 路由运行时，并以 React 工作台加载渠道、路由、反代、隧道、协议桥、自定义模型、Codex 热路由和观测。不依赖 VS Code 或已运行的其他网关。状态目录是 `~/.fomo-flow/` 与 `~/Library/Application Support/FOMO FLOW/`。Desktop 默认不改 IDE、Codex、系统代理、证书或公网隧道。

---

## Why FOMO FLOW

Most local proxies just forward requests. FOMO FLOW is a **routing brain**:

| Problem | What FOMO FLOW does |
| --- | --- |
| One provider 503 / 429 / TLS drop | Strike-based circuit breaker + periodic recovery probe + affinity restore |
| Expensive channel always wins | Cost-aware scoring (`inPer1k` / `outPer1k`) + latency + health ranking |
| Claude cache misses after failover | Conversation affinity park/restore + Anthropic beta header merge |
| Repeated local grep / search | Read-only tool result cache (2 min TTL, write tools never cached) |
| Protocol mess (OpenAI / Anthropic / Gemini / Responses) | Native adapters + reverse-proxy endpoints |
| “Did the fix even load?” | Live router diagnostics + cache hit rate logs |

If you run multiple API keys across Claude / GPT / Grok / GLM / DeepSeek and want **one local gateway that keeps working when any single upstream flakes**, this is the tool.

---

## Features

FOMO FLOW 定位是**中间层(一张桌子)**:坐在 IDE 与 API 服务层之间,做**路由、缓存、脱敏、监测、运维、增益**——而不是成为一个 IDE / agent。以下能力对单人 BYOK 使用同样有效。

### Routing & Resilience
- **Multi-provider routing** with sticky conversation affinity
- **Strike-based circuit breaker** — soft failures need N strikes; auth/balance/404 trip immediately
- **Auto recovery probe** — after open circuit, probe every few seconds with the *same* model + `extraHeaders`, clear circuit early, restore parked affinity
- **Circuit-grace sticky fallback** — priority 模式常态严守配置顺序;仅当主渠道熔断未恢复时,优先复用已"热"的备用渠道缓存,恢复后回到原序
- **Fallback chains** — primary → alternatives → explicit fallback
- **Channel scorer** — health, latency, cost, cache affinity, stability, quota, task fit, priority

### Protocol & Compatibility
- OpenAI Chat Completions / OpenAI Responses / Anthropic Messages / Gemini-compatible paths
- Local reverse-proxy endpoints for IDE / Codex hot routes(反代配置 mtime 内存缓存,避免每请求读盘)
- Protocol bridge:把 Chat-only 模型转换后供 Codex / Claude Code 等直调

### Three-Layer Cache(省钱,重复问答尤其明显)
- **① Exact-match cache** — 请求 byte 级相同直接回放,跳过上游($0,零风险);opt-in
- **② Semantic cache** — embedding 余弦近似命中即回放;需配 embeddings 端点,默认关,阈值保守(默认 0.95)
- **③ Provider prefix cache policy** — Anthropic `cache_control` 断点 / OpenAI `prompt_cache_key`,按模型分档、稳定前缀;命中率按协议正确统计;关闭/降级时不误发裸断点
- 三层省的钱互不重叠;命中率可在反代面板实时查看

### Security & Redaction
- **Outbound redaction** — 发往第三方 provider 前扫高置信度密钥/凭证(`sk-`/`sk-ant-`/`AKIA`/`AIza`/`ya29.`/GitHub/Slack/私钥块/JWT/Bearer),三态动作 `monitor` / `redact` / `block`;主路径与反代共用;默认关(另有高误报的 `credential_kv` 硬编码凭证规则,需显式开启)
- Request body limits + endpoint rate limiting
- Privacy-preserving action audit trail

### Observability & Ops
- 观测台:告警中心 · 失败模式统计 · 链路回放(路由→重试→换渠道→降级)· 动作审计 · 配置历史/一键回滚/配置包导入导出
- **OTEL export** — 每请求链路导出到 OTLP 后端(Jaeger / Tempo / Grafana);默认关,面板可开
- Token 用量/成本按渠道/模型可见;配置热生效 + 原子写 + 备份轮转
- Self-check / E2E commands;Overview / Model Routing / 观测台 webview 面板

### Prompt & Models
- **本源观照**:三态系统提示词(引导 invert / 官方直连 passthrough / 自定义 SP)
- **模型解锁**:注入全量约 109 模型目录;**快速切换模型**(状态栏 + 三步 QuickPick,`Ctrl/Cmd+Alt+M`)
- **自定义模型**:只填 API Key 自动识别;**Codex 热路由** + 精确差异(接受/回退同步变更)

### ACP Middleman(中间人 · 严守定位)
- FOMO FLOW 作为 **P/ACP 中间人**,坐在编辑器与真实 agent(Claude Code / Gemini CLI / Codex 等)之间,透明转发;**工具调用 / 权限请求一律透传**,自己不执行、不成为 IDE
- **可配置增益阶段链**(经 Conductor 编排,可开关/排序):`redact` 脱敏 · `inject` 注入 · `inject-detect` 注入监测 · `monitor` 监测 · `guard` 运维守卫
- **运维守卫**:出站 prompt 体积 / 频率 / 单块字符 / 块数限流,超限直接回 `refusal` 不惊动下游
- **注入监测**:出站 prompt/resource 块扫高置信度注入话术(忽略先前指令 / 系统提示词探测 / 角色劫持 / 越狱标志,中英双语),默认 `monitor` 只报不拦,`block` 命中即拒;默认关
- **监测 → OTEL**:ACP 每轮对话作为 span 流入可观测后端 + JSONL 审计
- 入口:`node scripts/dao-acp-proxy.js -- <real-agent-cmd> [args...]`
- (另有轻量 **独立 ACP agent** 形态 `scripts/dao-acp-agent.js`,可被宿主拉起跑多轮对话、带历史与 `session/load` 恢复;中间人为主线)

### Branding
- Extension identity: **FOMO FLOW · Model Gateway** · Publisher: `fomoflow` · Package: `fomo-flow`

---

## Quick Start

### 1. Install

From VSIX (recommended for latest local builds):

```bash
# Devin / VS Code style install
code --install-extension fomo-flow-9.9.424.vsix
# or open Extensions → ··· → Install from VSIX…
```

Latest packaged artifact from this tree:

- `fomo-flow-9.9.424.vsix`

After install, **reload / restart** the host app so the extension host picks up the new bundle.

### 2. Configure providers

User config path (example):

```text
~/.fomo-flow/配置.json
```

Minimal shape:

```json
{
  "providers": {
    "opus": {
      "baseUrl": "https://your-anthropic-compatible.example",
      "protocol": "anthropic",
      "completionPath": "/v1/messages",
      "streamMode": "stream",
      "enabled": true,
      "apiKey": "sk-…",
      "models": ["claude-opus-5"],
      "extraHeaders": {
        "anthropic-beta": "context-1m-2025-08-07"
      }
    },
    "glm": {
      "baseUrl": "https://open.bigmodel.cn/api/coding/paas",
      "enabled": true,
      "apiKey": "…",
      "models": ["glm-5.2"]
    }
  },
  "daoRoutes": {
    "models": {
      "claude-opus-5-high": {
        "provider": "opus",
        "model": "claude-opus-5",
        "autoFallback": true,
        "alternatives": [
          { "provider": "kfcoding", "model": "claude-opus-5" }
        ]
      }
    },
    "resilience": {
      "circuit": {
        "strikeThreshold": 3,
        "strikeWindowMs": 60000,
        "earlyProbeMs": 8000,
        "probeIntervalMs": 5000,
        "restoreAffinity": true
      }
    }
  }
}
```

### 3. Open the panels

Command Palette:

- `FOMO FLOW: Provider and Route Settings`
- `FOMO FLOW: External Provider Routing`
- `FOMO FLOW: Self Check`
- `FOMO FLOW: End-to-End Check`

Activity bar: **FOMO FLOW** → Overview / Model Routing.

---

## How Resilience Works

```text
upstream 5xx / network error
        │
        ▼
 soft strike (1/3, 2/3…)     hard fail (401 / balance / 404)
        │                              │
        ▼                              ▼
 open circuit after N strikes     open immediately
        │
        ├─ park conversation affinity
        ├─ skip channel in ranking
        └─ schedule recovery probes
               │
               ├─ first probe @ earlyProbeMs
               ├─ retry every probeIntervalMs
               ├─ probe uses circuit model + extraHeaders
               └─ alive? clear circuit + restore affinity
```

Live evidence in router diag (example):

```text
[熔断降敏] terra/gpt-5.6-terra network strike=2/3 · 暂不熔断
[自愈] terra/gpt-5.6-terra 探活成功 · 熔断提前解除 · 恢复会话=0
```

Observe yourself:

```bash
tail -f ~/.devin/extensions/fomoflow.fomo-flow-9.9.424/vendor/bundled-origin/_router_diag.log
```

You will also see cache lines like:

```text
_cacheUsage provider=glm model=glm-5.2 input=69254 cached=65024 hitRate=93.9%
```

---

## Anthropic Beta Header Merge

Older gateways often set:

```http
anthropic-beta: prompt-caching-2024-07-31
```

…and **overwrite** your `context-1m-…` token, causing 400/feature loss.

FOMO FLOW merges tokens:

```text
user extraHeaders["anthropic-beta"]
  ∪ prompt-caching-2024-07-31
  ∪ interleaved-thinking-… (if thinkingEnabled)
```

So long-context beta + prompt cache + thinking can coexist.

---

## Architecture (high level)

```text
IDE / Devin / Codex
        │  ACP stdio or local HTTP
        ▼
┌──────────────────────────────────────┐
│           FOMO FLOW Gateway           │
│  route → score → try → adapt → call  │
│  circuit · affinity · cache · audit  │
└──────────────────────────────────────┘
        │
        ├─ Anthropic-compatible providers
        ├─ OpenAI-chat / Responses providers
        └─ local reverse-proxy / Codex hot routes
```

Core modules:

| Module | Role |
| --- | --- |
| `vendor/外接api/core/dao_router.js` | routing, circuit, affinity, tool cache, probe |
| `vendor/外接api/core/adapters.js` | protocol adaptation + beta header compose |
| `vendor/外接api/core/channel_scorer.js` | multi-factor channel ranking |
| `vendor/外接api/core/action_audit.js` | request action audit |
| `ui/` | Overview + routing webviews |
| `test/feature-coverage.test.js` | feature regression suite |

---

## Tests

```bash
# 全量套件(核心 358 断言 + 全部 feature/selftest)
npm test

# 核心快检 / 反代自检
npm run test:quick
npm run test:revproxy

# 分组:缓存 / 脱敏 / OTEL / ACP 中间人与 agent
npm run test:exact-cache
npm run test:semantic-cache
npm run test:outbound-redact
npm run test:otel
npm run test:acp-proxy      # 中间人:透传/脱敏/监测/守卫 + 端到端
npm run test:acp-agent      # 独立 agent:握手/多轮历史/session load
```

Current feature suite covers, among others:

1. Circuit breaker policies + periodic recovery probe + affinity park/restore
2. Circuit-grace sticky fallback ordering
3. Channel scorer ranking; budget trim write-back
4. Three-layer cache: exact-match / semantic / provider prefix policy (protocol-aware hit rate; disabled-path strip)
5. Outbound secret/PII redaction (monitor/redact/block, prefix-stable)
6. OTEL/OTLP trace export mapping
7. ACP middleman: byte-faithful pass-through, tool-call pass-through, configurable augment stage chain, ops guard (size/rate/block limits), prompt-injection detection (monitor/block), monitoring → OTEL
8. ACP agent: handshake, streaming, multi-turn history, `session/load` resume + persistence
9. Anthropic beta header merge; action audit; branding metadata

---

## Install / Migrate Notes

| Content | In VSIX? | Needs separate migrate? |
| --- | --- | --- |
| Gateway + routing + adapters | Yes | No |
| Webview UI / commands | Yes | No |
| Provider API keys & routes | No | Yes (`配置.json`) |
| Project prompts / local state | No | Yes, if you use them |

Keys stay local. Do not commit `配置.json` with real secrets.

---

## Who This Is For

- 单人 **多 BYOK 端点**收敛到一个 IDE 模型槽后面(本项目对单人使用同样成立)
- 需要 **失败自愈**、不想盯着 503/429/TLS 抖动的人
- 混用 Claude prompt cache、长上下文 beta、多渠道路由的人
- 想要**本地、可审视**的网关(而非黑盒云代理),并希望把脱敏/缓存/监测作用到任意 IDE × 任意 agent 的人

---

## Roadmap-ish (honest)

Already solid:

- 熔断 + 探活自愈;成本/健康评分;熔断宽限期粘性回退
- 三层缓存(exact / semantic / provider prefix);预算裁剪写回;命中率协议感知
- 出站脱敏(密钥/凭证);Anthropic beta 合并;只读工具短缓存
- 可观测:观测台 + OTEL/OTLP 导出;配置热生效 + 原子写
- ACP 中间人:透传保真 + 工具透传 + 可配置增益阶段链 + 运维守卫 + 监测→OTEL
- branding / packaging

Still empirical / environment-dependent:

- 语义缓存阈值需按实际负载调(有假阳性风险,建议配 eval 监控)
- stream vs unary Claude cache-hit 在特定上游的对比(需健康的 Anthropic 兼容容量)
- provider-specific TLS reliability is still upstream physics — gateway can heal, not invent bandwidth

Intentionally **not** built(定位所限):

- FOMO FLOW 不做 IDE / 不执行工具 —— ACP 里工具调用/权限一律透传给真 agent
- 无多租户 / RBAC / 团队治理(面向单人 / 本地自托管)

---

## Contributing

1. Keep changes close to existing modules and config paths
2. Add / extend `test/feature-coverage.test.js` for behavioral contracts
3. Run `npm run test:quick` before packaging
4. Package with:

```bash
npx @vscode/vsce package --no-dependencies --skip-license
```

---

## License

Apache-2.0

---

## Credits

Built for people who treat model routing as infrastructure, not a toggle.

If this gateway saves you from a dead session at 2 a.m., star the repo and open an issue with the `_router_diag.log` line that mattered.

**FOMO FLOW · Model Gateway** — route calmly, fail soft, recover early.

# FOMO FLOW · Model Gateway

> **本地多渠道模型网关**——面向 Devin / VS Code / Windsurf / Codex 的 BYOK 路由层。
>
> 把 IDE 里的每一次模型请求，路由到你自己的渠道：自动故障转移、按成本/延迟/健康度评分选路、上游宕机周期探活自愈，并保住 Anthropic prompt cache 与会话亲和。

**不是只会转发的本地代理，而是会择优、会熔断、会自愈的路由层。**

---

## 它解决什么问题

同时持有多个模型渠道（Claude / GPT / Grok / GLM / DeepSeek 等）的人，每天都在撞同一批墙：

| 痛点 | FOMO FLOW 做法 |
| --- | --- |
| 某渠道 503 / 429 / TLS 断连 | 熔断降敏 + 周期探活 + 会话亲和恢复 |
| 总是打到贵渠道 | 成本感知评分（成本/延迟/健康度）自动择优 |
| 故障切换后 Claude 缓存丢失 | 会话亲和暂存/恢复 + Anthropic beta 头合并 |
| 本地 grep / 搜索反复打上游 | 只读工具结果短缓存（写入类工具永不缓存） |
| OpenAI / Anthropic / Gemini 协议混用 | 原生适配 + 本地反代入口 |
| 改完不知道有没有生效 | 路由诊断日志 + 缓存命中率实时可观测 |

---

## 功能全景

### 1. 路由与韧性（Routing & Resilience）

- **多渠道路由** + 会话粘性亲和（同一对话尽量留在同一渠道，保缓存）
- **计次熔断器**：软失败（网络抖动/5xx）需 N 次打击才熔断；硬失败（401/欠费/404）立即熔断
- **自动恢复探活**：熔断后按周期（默认 8s 首探 + 5s 间隔）用**同模型同头**探测，活了立即解除熔断并恢复被寄存的亲和会话
- **熔断宽限期粘性回退**：常态严守配置的渠道优先级；仅当主渠道熔断未恢复时，优先复用已「热」的备用渠道缓存，恢复后回到原序
- **三级回退链**：主渠道 → 备选列表 → 显式兜底
- **渠道评分器**：健康 / 延迟 / 成本（`inPer1k`/`outPer1k`）/ 缓存亲和 / 稳定性 / 配额 / 任务契合 / 优先级，多维加权排序

### 2. 协议与兼容（Protocol Bridge）

- **四协议原生适配**：OpenAI Chat Completions / OpenAI Responses / Anthropic Messages / Gemini
- **协议桥**：把 Chat-only 模型转换后供 Codex / Claude Code 等直调
- **本地反代端点**：给 IDE / Codex 热路由提供稳定本地入口（配置 mtime 内存缓存，不每请求读盘）
- **Codex 热路由**：`~/.codex/config.toml` 一次性指向本地入口后，切渠道/模型/推理强度无需再重启 Codex

### 3. 三层缓存（省钱核心）

| 层 | 机制 | 何时命中 | 风险 |
| --- | --- | --- | --- |
| ① 精确缓存 | 请求 byte 级相同直接回放 | 重复问答、重试 | $0，零风险（opt-in） |
| ② 语义缓存 | embedding 余弦 ≥0.95 回放 | 换个说法的同一问题 | 默认关，阈值保守 |
| ③ 前缀缓存策略 | Anthropic `cache_control` 断点 / OpenAI `prompt_cache_key`，按模型分档稳定前缀 | 长对话、多轮工具调用 | 命中率按协议正确统计 |

- 三层省的钱互不重叠；命中率在面板实时可查（例：`hitRate=93.9%, cached=65024/69254 tokens`）
- **前缀连续性分类**：按前缀哈希判定会话缓存连续性（OpenAI 口径 cached 含在 input、Anthropic 口径单独报 cache read，两种量纲统一折算到 0-100%）
- **Anthropic beta 头合并**：用户的 `context-1m` 与 `prompt-caching` 与 `interleaved-thinking` 令牌并集共存——旧网关直接覆盖导致 400/功能丢失的问题根治

### 4. 长对话上下文治理

- **工具输出持久化**：较早的大型工具结果转内容哈希稳定引用（`dao-output://`）+ 头尾预览，最近 4 条仍完整内联；配套 `dao_read_tool_output` 回读工具按需取全文
- 实战案例：修复 27 轮调用累计输入 **426.8 万 token**、单轮从 10.3 万涨到 25.6 万的上下文膨胀（根因：历史工具结果全量内联，cacheKey 哈希稳定但上游命中率骤降）
- 只读工具（grep/搜索）2 分钟短缓存；**写入类工具永不缓存**

### 5. 安全与脱敏

- **出站脱敏**：发往第三方前扫描高置信度密钥/凭证（`sk-` / `sk-ant-` / `AKIA` / `AIza` / GitHub / Slack / 私钥块 / JWT / Bearer），三态动作 `monitor` / `redact` / `block`，主路径与反代共用
- 请求体大小限制 + 端点级限流；隐私保留的动作审计轨迹
- 密钥只存本地 `~/.fomo-flow/`，永不入仓

### 6. ACP 中间人（Agent Client Protocol）

- 坐在编辑器与真实 agent（Claude Code / Gemini CLI / Codex）之间**透明转发**——工具调用/权限请求一律透传，自己不执行、不成为 IDE
- **可配置增益阶段链**（可开关/可排序）：`redact` 脱敏 → `inject` 注入 → `inject-detect` 注入监测 → `monitor` 监测 → `guard` 运维守卫
- **运维守卫**：出站 prompt 体积/频率/单块字符/块数限流，超限直接 `refusal` 不惊动下游
- **注入监测**：扫「忽略先前指令/系统提示词探测/角色劫持/越狱」话术（中英双语），默认只报不拦
- 另有轻量**独立 ACP agent** 形态：可被宿主拉起多轮对话、带历史与 `session/load` 断点恢复

### 7. 可观测性

- **观测台**：告警中心 · 失败模式统计 · 链路回放（路由→重试→换渠道→降级）· 动作审计 · 配置历史/一键回滚
- **OTEL 导出**：每请求链路 → OTLP 后端（Jaeger / Tempo / Grafana），面板可开
- **TTFT 首字延迟指标**：按渠道/模型分桶采样首 token 延迟（全局 50 样本 + 分组 20 样本滚动窗口），选路可参考真实体感而非只看均延迟
- **Agent Status 观测面**：会话/渠道/请求三层滚动投影（各自限额 + 活跃/过期 TTL），多 agent 并发时一屏看全；状态纪律带防投毒（antipoison）、goal 白名单、**不推断 verdict**（只采信 agent 显式声明）
- Token 用量/成本按渠道/模型统计；配置热生效 + 原子写 + 备份轮转
- 路由诊断日志实时可 tail（`[熔断降敏] strike=2/3` / `[自愈] 探活成功·恢复会话=0`）

### 8. 交付形态

- **VS Code 扩展**（v9.9.425，`code --install-extension` 即装）：命令面板配置 + Activity Bar 面板（Overview / Model Routing / 观测台）
- **macOS Electron Desktop**：Apple Silicon 独立交付，自带路由运行时 + React 工作台，不依赖 VS Code
- **模型解锁**：注入全量约 109 模型目录；状态栏 + 三步 QuickPick 快速切换（`Ctrl/Cmd+Alt+M`）

---

### 9. Codex 协作增强

- **工作区变更审查**：自动捕获 Codex / Devin / 外部程序对工作区文件的新增/修改/删除，面板集中显示 `A/M/D/?` 状态 + 增删行统计；支持多根工作区、单文件/全部接受、单文件/全部回滚
- **回滚安全**：回滚前校验磁盘哈希与脏编辑器，发现「Codex 写完又被人工/其他 agent 改过」时拒绝覆盖，绝不误伤新修改
- **SCM 双视图桥**：同一份前后快照同时注册为 VS Code 原生 SCM 与插件面板差异视图（共享 `filePath+beforeHash+afterHash` 指纹），Accept/Reject 推进同一基线，不产生重复 diff
- **智能忽略**：Unity `Library/Temp`、依赖/构建目录、二进制、>2MB 文件自动跳过（精确规则不误伤 `Assets/Library`）
- **热路由配置同步视图**：每 3 秒轻量读取 Codex 实际 `model_provider`/模型/推理强度，面板显示真实值与保存路由是否漂移；只返回非敏感字段

## 架构

```text
IDE / Devin / Codex
        │  ACP stdio or local HTTP
        ▼
┌────────────────────────────────────┐
│        FOMO FLOW Gateway           │
│  route → score → try → adapt → call│
│  circuit · affinity · cache · audit│
└────────────────────────────────────┘
        │
        ├─ Anthropic-compatible providers
        ├─ OpenAI-chat / Responses providers
        └─ local reverse-proxy / Codex hot routes
```

**韧性状态机**（一条失败的生命周期）：

```text
upstream 5xx / network error          hard fail (401 / balance / 404)
        │                                       │
        ▼                                       ▼
 soft strike (1/3, 2/3…)                open immediately
        │
        ▼
 open circuit after N strikes
        │
        ├─ park conversation affinity     ← 缓存亲和寄存
        ├─ skip channel in ranking        ← 评分降权
        └─ schedule recovery probes       ← 8s 首探 + 5s 周期
               │
               └─ alive? clear circuit + restore affinity
```

**测试规模**：110 个测试文件按域分层（协议桥 / 缓存亲和 / 上下文策略 / 工具策略 / 工作区 / 热路由 / ACP 代理 / 注入监测 / 守卫 / OTEL …），35+ npm test 入口，358 条核心断言，发布前全绿。

---

## 快速上手

### 安装（VSIX）

```bash
code --install-extension fomo-flow-9.9.425.vsix
# 或 VS Code 扩展面板 → ··· → Install from VSIX…
```

安装后重载宿主。配置路径：`~/.fomo-flow/配置.json`（密钥只存本地，永不入仓）。

### 最小配置示例

```json
{
  "providers": {
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
        "provider": "opus", "model": "claude-opus-5",
        "autoFallback": true,
        "alternatives": [{"provider": "kfcoding", "model": "claude-opus-5"}]
      }
    },
    "resilience": {
      "circuit": {
        "strikeThreshold": 3, "strikeWindowMs": 60000,
        "earlyProbeMs": 8000, "probeIntervalMs": 5000, "restoreAffinity": true
      }
    }
  }
}
```

### 跑测试

```bash
npm test                # 全量：358 core 断言 + 全部 feature
npm run test:quick      # 核心快检
npm run test:revproxy   # 反代自检
npm run test:exact-cache / test:semantic-cache / test:outbound-redact / test:otel / test:acp-proxy
```

### 看它活着（实测日志样例）

```text
[熔断降敏] terra/gpt-5.6-terra network strike=2/3 · 暂不熔断
[自愈] terra/gpt-5.6-terra 探活成功 · 熔断提前解除 · 恢复会话=0
_cacheUsage provider=glm model=glm-5.2 input=69254 cached=65024 hitRate=93.9%
```

## 定位边界（诚实声明）

**刻意不做**：
- 不做 IDE、不执行工具——ACP 里工具调用/权限一律透传给真实 agent
- 无多租户 / RBAC / 团队治理——面向单人与本地自托管
- 网关能治愈上游抖动，但不能发明带宽——provider 级 TLS 可靠性仍是上游物理

**仍在经验区间**：语义缓存阈值需按负载调（有假阳性风险，建议配 eval 监控）。

---

## 关于本仓

本仓是**公开案例（case study）仓**：功能清单、架构与设计决策公开可读；完整源码与渠道配置保持私有（含真实渠道细节的配置永不公开）。作者同一时期的主项目见 [moscrol/showcase](https://github.com/moscrol/showcase)（A 股主题投资情报工作台——证据分级的金融 Agent）。

## License

Apache-2.0

"use strict";
// 两个配置项的真实语义（2026-08-11 核对 OpenAI + Azure 官方文档）
//
// ── openaiTtl ────────────────────────────────────────────────────────────────
// 官方：`prompt_cache_options.ttl` 目前 **只支持 30m**，且 30m 就是默认值。
//   > "All breakpoints use the request-wide prompt_cache_options.ttl,
//   >  which currently defaults to 30m and is the only supported value."
// 所以代码里硬编码 30m **是对的**，不是缺陷。
// 真正的缺陷是**静默改写**：传 openaiTtl:"1h" 进去，出来是 "30m"，
// 没有报错、没有诊断字段，配置方无从得知自己的意图被丢弃了。
// 后果不是算错值，是**误导归因**——「我不是已经调成 1h 了吗」会让人跑去查
// 网络/上游/协议，而真因（TTL 从来就是 30m）被自己的错误前提挡住。
//
// 修法：值仍固定 30m，但把「请求了不支持的值」记进 diagnostics.cacheDowngrade，
// 与既有的 openai-explicit / anthropic-1h 降级用同一套上报口径。
//
// ── legacyRetention ──────────────────────────────────────────────────────────
// 官方：`prompt_cache_retention` 是**真实存在**的 API 字段，枚举恰为
// "in_memory" | "24h"，与代码里的归一化完全对应。对 gpt-5.6+ 已废弃，
// 对更早模型有效（24h = 扩展缓存，最长保留 24 小时）。
//   > "prompt_cache_retention: Optional[Literal["in_memory", "24h"]]
//   >  Deprecated. Use prompt_cache_options.ttl instead. ...
//   >  This field expresses a maximum retention policy, while
//   >  prompt_cache_options.ttl expresses a minimum cache lifetime."
// 实测：该值被读入、归一化、存好，然后**从不写进出站请求**——出站 body 里
// 只有 prompt_cache_key。它是个死配置，不是设计约束。
//
// 修法：接上线。只对**非 gpt-5.6+** 的模型下发（官方对新模型已废弃该字段，
// 下发可能招 400）；explicit 模式与它互斥（ttl 与 retention 是两套独立机制，
// 官方明说 "do not interact"，但同时下发对旧模���无意义因为旧模型不支持 explicit）。
//
// 参考：~/agent-memory/10_knowledge/evidence-hygiene-three-failure-shapes.md 形状二
// （手写清单必漂——文档说可配、实际写死，两边漂了）

const path = require("path");
const { createPromptCachePolicy } = require(
  path.join(__dirname, "..", "vendor/外接api/core/prompt_cache_policy.js"),
);

const F = "\x1b[31mFAIL\x1b[0m",
  P = "\x1b[32mPASS\x1b[0m";
let bad = 0;
function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? P : F}  ${desc}`);
  if (!ok)
    console.log(
      `      got=${JSON.stringify(got)}\n      want=${JSON.stringify(want)}`,
    );
}

const policy = createPromptCachePolicy({ now: () => 1_000_000 });

function chatPlan(settings, model = "gpt-5.6-terra") {
  return policy.plan({
    providerId: "k|https://x.invalid",
    protocol: "openai-chat",
    model,
    sessionKey: "dao:k",
    settings: Object.assign({ enabled: true }, settings),
  });
}

// 够大的稳定前缀（约 1250 token > 1024 下限），确保 explicit 路径真的走到
function chatBody(model = "gpt-5.6-terra") {
  return {
    model,
    messages: [
      { role: "system", content: "S".repeat(6000) },
      { role: "user", content: "word ".repeat(1000) },
      { role: "user", content: "<!--dao-agent-status--> volatile" },
    ],
  };
}

console.log(
  "=== A. openaiTtl：值固定 30m（官方唯一支持值），但不再静默改写 ===",
);

const a1 = policy.decorate(
  chatBody(),
  chatPlan({ openaiMode: "explicit", openaiTtl: "30m" }),
);
check(
  "A-1: 传 30m（合法）→ 出站 ttl=30m",
  a1.body.prompt_cache_options.ttl,
  "30m",
);
check("A-1: 传 30m → 无降级上报", a1.diagnostics.cacheDowngrade, null);

const a2 = policy.decorate(
  chatBody(),
  chatPlan({ openaiMode: "explicit", openaiTtl: "1h" }),
);
check(
  "A-2: 传 1h（不支持）→ 出站仍是 30m（官方唯一支持值）",
  a2.body.prompt_cache_options.ttl,
  "30m",
);
check(
  "A-2: 传 1h → 必须上报降级，不能静默吞掉",
  a2.diagnostics.cacheDowngrade,
  "openai-ttl",
);

const a3 = policy.decorate(chatBody(), chatPlan({ openaiMode: "explicit" }));
check(
  "A-3: 不传 → 取默认 30m，无降级",
  [a3.body.prompt_cache_options.ttl, a3.diagnostics.cacheDowngrade],
  ["30m", null],
);

console.log("\n=== B. legacyRetention：接上线，只对非 gpt-5.6+ 下发 ===");

const b1 = policy.decorate(
  chatBody("gpt-4o"),
  chatPlan({ legacyRetention: "24h" }, "gpt-4o"),
);
check(
  "B-1: gpt-4o + 24h → 出站带 prompt_cache_retention",
  b1.body.prompt_cache_retention,
  "24h",
);

const b2 = policy.decorate(
  chatBody("gpt-4o"),
  chatPlan({ legacyRetention: "in_memory" }, "gpt-4o"),
);
check(
  "B-2: gpt-4o + in_memory → 出站带该值",
  b2.body.prompt_cache_retention,
  "in_memory",
);

const b3 = policy.decorate(
  chatBody("gpt-4o"),
  chatPlan({ legacyRetention: "48h" }, "gpt-4o"),
);
check(
  "B-3: 非法值 48h → 不下发（归一化拒绝）",
  b3.body.prompt_cache_retention,
  undefined,
);

const b4 = policy.decorate(chatBody(), chatPlan({ legacyRetention: "24h" }));
check(
  "B-4: gpt-5.6（官方已废弃该字段）→ 不下发",
  b4.body.prompt_cache_retention,
  undefined,
);

const b5 = policy.decorate(chatBody("gpt-4o"), chatPlan({}, "gpt-4o"));
check(
  "B-5: 不配 → 不出现该字段（不凭空加）",
  b5.body.prompt_cache_retention,
  undefined,
);

console.log("\n=== C. 反例：既有能力不受影响 ===");

const c1 = policy.decorate(chatBody(), chatPlan({ openaiMode: "explicit" }));
check(
  "C-1: explicit 模式仍生效",
  c1.body.prompt_cache_options.mode,
  "explicit",
);
check("C-1: prompt_cache_key 仍下发", c1.body.prompt_cache_key, "dao:k");
check(
  "C-1: 消息级 breakpoint 仍在打",
  c1.diagnostics.breakpointCount >= 2,
  true,
);

// Anthropic 侧完全不受这两个 OpenAI 专属旋钮影响
const c2 = policy.decorate(
  {
    model: "claude-opus-4-5",
    system: [{ type: "text", text: "S".repeat(20000) }],
    tools: [],
    messages: [
      { role: "user", content: "word ".repeat(2000) },
      { role: "user", content: "<!--dao-agent-status--> volatile" },
    ],
  },
  policy.plan({
    providerId: "k2|https://y.invalid",
    protocol: "anthropic",
    model: "claude-opus-4-5",
    sessionKey: "dao:k2",
    settings: { enabled: true, legacyRetention: "24h", openaiTtl: "1h" },
  }),
);
check(
  "C-2: Anthropic 不带 prompt_cache_retention",
  c2.body.prompt_cache_retention,
  undefined,
);
check(
  "C-2: Anthropic 不因 openaiTtl 触发降级",
  c2.diagnostics.cacheDowngrade,
  null,
);

console.log(bad === 0 ? "\n✅ 全部通过" : `\n❌ ${bad} 项未通过`);
process.exit(bad === 0 ? 0 : 1);

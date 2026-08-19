"use strict";
// 最小可缓存 token 分档 + system/tools 断点门槛
//
// 依据：Bedrock 官方模型卡「Minimum number of tokens per cache checkpoint」
// （2026-08-11 核对）。低于该值时 provider **照常成功、按全价计费、静默不缓存**，
// 且那个 breakpoint 仍占掉 4 个槽位之一。
//
//     Claude Sonnet 4.5    4,096      Claude Opus 4.5      4,096
//     Claude Sonnet 4.6    1,024      Claude Opus 4.6      4,096
//     Claude 3.7 Sonnet    1,024      Claude Haiku 4.5     4,096
//                                     Claude Haiku 3/3.5   2,048
//
// 缺陷 A（分档误判）：初版判据 /opus|haiku/ → 4096，else → 1024，把
//   **Sonnet 4.5 漏成 1024 档**。同一"Sonnet"家族里 4.5 和 4.6 分属不同档，
//   按家族名分档必然出错。未知模型也一律落 1024（激进档）。
//
// 缺陷 B（system/tools 不受门槛约束）：消息级 breakpoint 已做门槛过滤，
//   但 system 和 tools 的 breakpoint 无条件打标。实测 system 1 token +
//   tools 3 token、模型下限 4096 �� breakpointCount=2，两个必然 no-op 的
//   断点各占一个槽位，与消息级断点争抢同一个 4 槽预算。判据不一致。
//
// 参考：~/agent-memory/10_knowledge/evidence-hygiene-three-failure-shapes.md 形状二（手写清单必漂）

const assert = require("node:assert");
const path = require("path");
const { createPromptCachePolicy } = require(
  path.join(__dirname, "..", "vendor/外接api/core/prompt_cache_policy.js"),
);

const F = "\x1b[31mFAIL\x1b[0m", P = "\x1b[32mPASS\x1b[0m";
let bad = 0;
function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? P : F}  ${desc}`);
  if (!ok) console.log(`      got=${JSON.stringify(got)}\n      want=${JSON.stringify(want)}`);
}

const policy = createPromptCachePolicy({ now: () => 1_000_000 });

function planFor(model, settings) {
  return policy.plan({
    providerId: "t|https://x.invalid",
    protocol: "anthropic",
    model,
    sessionKey: "dao:t",
    settings: Object.assign({ enabled: true }, settings || {}),
  });
}

// 造一个「消息前缀恰好落在 1024 与 4096 之间」的请求：
// 约 1250 token（1000 个 "word " ≈ 5000 char / 4 = 1250 token）。
// 1024 档模型应授予消息级 breakpoint，4096 档应拒绝。
function bodyBetweenTiers(model) {
  return {
    model,
    system: [{ type: "text", text: "S".repeat(200) }], // 约 50 token
    tools: [],
    messages: [
      { role: "user", content: "word ".repeat(1000) },
      { role: "user", content: "<!--dao-agent-status--> volatile" },
    ],
  };
}

// 直接检查那条消息有没有被打上 cache_control，不要用 breakpointCount 当代理。
//
// 踩过的坑：初版判据写 `breakpointCount >= 2`，隐含假设「system 断点总会占掉 1」。
// 但 system 断点本身也受门槛约束（见 D 组），本夹具里 system 只有约 50 token，
// 达不到 1024，于是 breakpointCount 只有 1 —— 判据被自己要测的改动污染了，
// 报出来的失败方向是反的（看着像分档表错了，实际是代理指标错了）。
function messageBreakpointGranted(model) {
  const out = policy.decorate(bodyBetweenTiers(model), planFor(model));
  const first = out.body.messages[0];
  const blocks = Array.isArray(first.content) ? first.content : [];
  return blocks.some((b) => b && b.cache_control);
}

console.log("=== A. 分档表对照官方模型卡 ===");
check("A-1: Sonnet 4.5 = 4096 档 → 1250 token 前缀被拒",
  messageBreakpointGranted("claude-sonnet-4-5-20250929"), false);
check("A-2: Sonnet 4.6 = 1024 档 → 1250 token 前缀被授予",
  messageBreakpointGranted("claude-sonnet-4-6"), true);
check("A-3: Opus 4.5 = 4096 档 → 被拒",
  messageBreakpointGranted("claude-opus-4-5"), false);
check("A-4: Opus 4.6 = 4096 档 → 被拒",
  messageBreakpointGranted("claude-opus-4-6"), false);
check("A-5: Haiku 4.5 = 4096 档 → 被拒",
  messageBreakpointGranted("claude-haiku-4-5"), false);
check("A-6: Claude 3.7 Sonnet = 1024 档 → 被授予",
  messageBreakpointGranted("claude-3-7-sonnet-20250219"), true);
check("A-7: Haiku 3.5 = 2048 档 → 1250 token 被拒",
  messageBreakpointGranted("claude-3-5-haiku-20241022"), false);

console.log("\n=== B. 未知模型取保守档（4096），不是激进档 ===");
check("B-1: 未知模型名 → 保守拒绝",
  messageBreakpointGranted("some-brand-new-model"), false);
check("B-2: 未标版本的 sonnet → 取家族最严档",
  messageBreakpointGranted("claude-sonnet-latest"), false);

console.log("\n=== C. OpenAI 系走自己的 1024 下限 ===");
// OpenAI 协议下 explicit 模式，前缀 1250 token 应过 1024 门槛
const gptPlan = policy.plan({
  providerId: "g|https://y.invalid",
  protocol: "openai-chat",
  model: "gpt-5.6-terra",
  sessionKey: "dao:g",
  settings: { enabled: true, openaiMode: "explicit" },
});
const gptOut = policy.decorate({
  model: "gpt-5.6-terra",
  messages: [
    { role: "system", content: "S".repeat(200) },
    { role: "user", content: "word ".repeat(1000) },
    { role: "user", content: "<!--dao-agent-status--> volatile" },
  ],
}, gptPlan);
check("C-1: gpt-5.6 前缀 1250 token → 消息级 breakpoint 被授予",
  gptOut.diagnostics.breakpointCount >= 2, true);

console.log("\n=== D. system / tools 断点也受最小 token 门槛约束 ===");
const tinyPlan = planFor("claude-opus-4-5");
const tinyOut = policy.decorate({
  model: "claude-opus-4-5",
  system: [{ type: "text", text: "hi" }],           // 约 1 token
  tools: [{ name: "t", description: "d" }],          // 约 3 token
  messages: [
    { role: "user", content: "hi" },
    { role: "user", content: "<!--dao-agent-status--> volatile" },
  ],
}, tinyPlan);
check("D-1: 极小 system(1t)+tools(3t)，下限 4096 → 不打 system 断点",
  !!(tinyOut.body.system[0] || {}).cache_control, false);
check("D-2: 极小 tools → 不打 tools 断点",
  !!(tinyOut.body.tools[0] || {}).cache_control, false);
check("D-3: breakpointCount 为 0（全是 no-op，不占槽位）",
  tinyOut.diagnostics.breakpointCount, 0);

// 对照：够大的 system + tools 仍应打标（防门槛过严成瞎子）
//
// 注意累计口径遵循 Anthropic 缓存层级 tools → system → messages：
//   tools 断点  保护 tools 段本身          → 判据是 toolsTokens
//   system 断点 保护 tools + system 段     → 判据是累计值
// 所以要让 tools 断点成立，tools 自己就得过 4096 token（≈16400 char）。
const bigOut = policy.decorate({
  model: "claude-opus-4-5",
  system: [{ type: "text", text: "S".repeat(20000) }],    // 约 5000 token
  tools: [{ name: "t", description: "d".repeat(20000) }], // 约 5000 token
  messages: [
    { role: "user", content: "word ".repeat(2000) },
    { role: "user", content: "<!--dao-agent-status--> volatile" },
  ],
}, planFor("claude-opus-4-5"));
check("D-4: 够大的 system → 仍打断点（防门槛过严成瞎子）",
  !!(bigOut.body.system[0] || {}).cache_control, true);
check("D-5: 够大的 tools（5000t > 4096）→ 仍打断点",
  !!(bigOut.body.tools[0] || {}).cache_control, true);

// D-6 反例：tools 自己不够大（2000t < 4096）→ tools 断点该被拒，
// 但 tools+system 累计够大时 system 断点仍应成立。
// 这一条钉住「累计口径」而非「各自独立判断」。
const midToolsOut = policy.decorate({
  model: "claude-opus-4-5",
  system: [{ type: "text", text: "S".repeat(20000) }],   // 约 5000 token
  tools: [{ name: "t", description: "d".repeat(8000) }], // 约 2000 token < 4096
  messages: [
    { role: "user", content: "word ".repeat(2000) },
    { role: "user", content: "<!--dao-agent-status--> volatile" },
  ],
}, planFor("claude-opus-4-5"));
check("D-6: tools 单独不够 → 不打 tools 断点",
  !!(midToolsOut.body.tools[0] || {}).cache_control, false);
check("D-6: 但 tools+system 累计够 → system 断点成立",
  !!(midToolsOut.body.system[0] || {}).cache_control, true);

console.log("\n=== E. 显式 minBreakpointTokens=0 保留旧行为（对照实验用）===");
const zeroOut = policy.decorate({
  model: "claude-opus-4-5",
  system: [{ type: "text", text: "hi" }],
  tools: [{ name: "t", description: "d" }],
  messages: [
    { role: "user", content: "hi" },
    { role: "user", content: "<!--dao-agent-status--> volatile" },
  ],
}, planFor("claude-opus-4-5", { minBreakpointTokens: 0 }));
check("E-1: minBreakpointTokens=0 → system 仍打标（不设门槛）",
  !!(zeroOut.body.system[0] || {}).cache_control, true);
check("E-2: minBreakpointTokens=0 → 消息级也打标",
  zeroOut.diagnostics.breakpointCount >= 3, true);

console.log("\n=== F. 4 槽上限仍被遵守 ===");
const manyOut = policy.decorate({
  model: "claude-sonnet-4-6",
  system: [{ type: "text", text: "S".repeat(8000) }],
  tools: [{ name: "t", description: "d".repeat(8000) }],
  messages: [
    { role: "user", content: "word ".repeat(1000) },
    { role: "user", content: "<!-- DAO-CONTEXT-CHECKPOINT --> ck" },
    { role: "assistant", content: "word ".repeat(1000) },
    { role: "user", content: "word ".repeat(1000) },
    { role: "user", content: "<!--dao-agent-status--> volatile" },
  ],
}, planFor("claude-sonnet-4-6"));
check("F-1: breakpointCount <= 4", manyOut.diagnostics.breakpointCount <= 4, true);

console.log(bad === 0 ? "\n✅ 全部通过" : `\n❌ ${bad} 项未通过`);
process.exit(bad === 0 ? 0 : 1);

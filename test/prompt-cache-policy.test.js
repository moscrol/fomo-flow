"use strict";

const assert = require("node:assert");
const {
  createPromptCachePolicy,
} = require("../vendor/外接api/core/prompt_cache_policy.js");

(async function main() {
  let now = 1_000_000;
  const scheduled = [];
  const cancelled = [];
  const warmups = [];
  const policy = createPromptCachePolicy({
    now: () => now,
    schedule(fn, delay) {
      const timer = { fn, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    cancel(timer) { cancelled.push(timer); },
    async sendWarmup(snapshot) { warmups.push(snapshot); },
  });

  const chatInput = {
    providerId: "ay|https://gateway.invalid",
    protocol: "openai-chat",
    model: "gpt-5.6-terra",
    sessionKey: "dao:session-a",
    settings: {
      enabled: true,
      openaiMode: "explicit",
      openaiTtl: "30m",
    },
  };
  const chatPlan = policy.plan(chatInput);
  const originalChat = {
    model: "gpt-5.6-terra",
    messages: [
      { role: "system", content: "S".repeat(5_000) },
      { role: "user", content: "stable request" },
      { role: "user", content: "<!--dao-agent-status--> changing" },
    ],
  };
  const decoratedChat = policy.decorate(originalChat, chatPlan);
  assert.deepStrictEqual(decoratedChat.body.prompt_cache_options, {
    mode: "explicit",
    ttl: "30m",
  });
  assert.strictEqual(decoratedChat.body.prompt_cache_key, "dao:session-a");
  assert.ok(
    decoratedChat.body.messages[0].content[0].prompt_cache_breakpoint,
    "system content is an explicit stable breakpoint",
  );
  assert.ok(
    decoratedChat.body.messages[1].content[0].prompt_cache_breakpoint,
    "the last stable message is cached",
  );
  assert.strictEqual(
    decoratedChat.body.messages[2].content[0].prompt_cache_breakpoint,
    undefined,
    "Agent HUD remains after the final breakpoint",
  );
  assert.strictEqual(originalChat.messages[0].content.length, 5_000);
  assert.strictEqual(typeof originalChat.messages[0].content, "string");
  assert.strictEqual(decoratedChat.diagnostics.cacheMode, "explicit");
  assert.strictEqual(decoratedChat.diagnostics.cacheTtl, "30m");
  assert.strictEqual(decoratedChat.diagnostics.breakpointCount, 2);
  assert.strictEqual(decoratedChat.diagnostics.volatileSuffixCount, 1);
  assert.match(decoratedChat.diagnostics.stablePrefixHash, /^[a-f0-9]{12}$/);
  assert.match(decoratedChat.diagnostics.cacheFamilyHash, /^[a-f0-9]{12}$/);
  assert.ok(decoratedChat.diagnostics.stablePrefixChars >= 5_000);
  assert.doesNotMatch(JSON.stringify(decoratedChat.diagnostics), /session-a|stable request/);
  const nextTurn = policy.decorate({
    ...originalChat,
    messages: [
      originalChat.messages[0],
      originalChat.messages[1],
      { role: "assistant", content: "new assistant turn" },
      { role: "user", content: "new user turn" },
      originalChat.messages[2],
    ],
  }, chatPlan);
  assert.strictEqual(
    nextTurn.diagnostics.cacheFamilyHash,
    decoratedChat.diagnostics.cacheFamilyHash,
  );
  assert.notStrictEqual(
    nextTurn.diagnostics.stablePrefixHash,
    decoratedChat.diagnostics.stablePrefixHash,
  );

  const responsesPlan = policy.plan({ ...chatInput, protocol: "openai-responses" });
  // instructions 必须够大：消息级 breakpoint 有最小可缓存长度门槛（gpt-5.6 档
  // 1024 token），达不到时 provider 会静默不缓存，本模块因此不再浪费 breakpoint
  // 槽位。原夹具 "stable instructions" 仅约 5 token，是个 sub-minimum 前缀。
  const decoratedResponses = policy.decorate({
    model: "gpt-5.6-terra",
    instructions: "stable instructions ".repeat(300), // ≈1500 token
    input: [
      { role: "user", content: "stable input" },
      { role: "user", content: "<!--dao-agent-status--> dynamic" },
    ],
  }, responsesPlan);
  assert.deepStrictEqual(decoratedResponses.body.prompt_cache_options, {
    mode: "explicit",
    ttl: "30m",
  });
  assert.ok(
    decoratedResponses.body.input[0].content[0].prompt_cache_breakpoint,
  );
  assert.strictEqual(
    decoratedResponses.body.input[1].content[0].prompt_cache_breakpoint,
    undefined,
  );

  const anthropicInput = {
    providerId: "opus|https://anthropic.invalid",
    protocol: "anthropic",
    model: "claude-opus-5",
    sessionKey: "dao:anthropic",
    settings: { enabled: true, anthropicTtl: "5m", minBreakpointTokens: 0 },
  };
  const anthropicPlan = policy.plan(anthropicInput);
  const decoratedAnthropic = policy.decorate({
    model: "claude-opus-5",
    system: [{
      type: "text",
      text: "system",
      cache_control: { type: "ephemeral", ttl: "1h" },
    }],
    tools: [
      { name: "Read", input_schema: { type: "object" } },
      { name: "Edit", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: "initial stable requirement" },
      { role: "user", content: "<!-- DAO-CONTEXT-CHECKPOINT --> rolling summary" },
      { role: "assistant", content: "stable after checkpoint" },
      { role: "user", content: "<!--dao-agent-status--> changing" },
    ],
  }, anthropicPlan);
  assert.deepStrictEqual(decoratedAnthropic.body.system[0].cache_control, {
    type: "ephemeral",
  });
  assert.deepStrictEqual(decoratedAnthropic.body.tools[1].cache_control, {
    type: "ephemeral",
  });
  assert.ok(decoratedAnthropic.body.messages[0].content[0].cache_control);
  assert.strictEqual(
    decoratedAnthropic.body.messages[1].content[0].cache_control,
    undefined,
  );
  assert.ok(decoratedAnthropic.body.messages[2].content[0].cache_control);
  assert.strictEqual(
    decoratedAnthropic.body.messages[3].content[0].cache_control,
    undefined,
  );
  assert.strictEqual(decoratedAnthropic.diagnostics.breakpointCount, 4);
  assert.strictEqual(decoratedAnthropic.diagnostics.volatileSuffixCount, 2);

  const hourPlan = policy.plan({
    ...anthropicInput,
    settings: { enabled: true, anthropicTtl: "1h", minBreakpointTokens: 0 },
  });
  const hourBody = policy.decorate({
    system: "long system",
    messages: [{ role: "user", content: "stable" }],
  }, hourPlan).body;
  assert.strictEqual(hourBody.system[0].cache_control.ttl, "1h");
  assert.strictEqual(hourBody.messages[0].content[0].cache_control.ttl, "1h");

  const explicitDowngrade = policy.observeFailure({
    providerId: chatPlan.providerId,
    protocol: "openai-chat",
    status: 400,
    body: 'Unknown parameter: "prompt_cache_options"',
  });
  assert.deepStrictEqual(explicitDowngrade, {
    retry: true,
    feature: "openai-explicit",
  });
  const implicitPlan = policy.plan(chatInput);
  assert.strictEqual(implicitPlan.capability.openaiExplicit, false);
  const implicitBody = policy.decorate(originalChat, implicitPlan);
  assert.strictEqual(implicitBody.body.prompt_cache_key, "dao:session-a");
  assert.strictEqual(implicitBody.body.prompt_cache_options, undefined);
  assert.strictEqual(typeof implicitBody.body.messages[0].content, "string");
  assert.strictEqual(implicitBody.diagnostics.cacheDowngrade, "openai-explicit");

  const implicitOriginal = {
    model: "claude-opus-5",
    tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
    messages: [
      { role: "system", content: "stable system" },
      { role: "user", content: "stable task" },
      { role: "assistant", content: "I will inspect it" },
      { role: "tool", tool_call_id: "tool-1", content: "safe result" },
      { role: "user", content: "<!--dao-agent-status--> changing" },
    ],
  };
  const implicitSnapshot = JSON.parse(JSON.stringify(implicitOriginal));
  const implicitStable = policy.decorate(implicitOriginal, policy.plan({
    providerId: "cccc|https://chat.invalid",
    protocol: "openai-chat",
    model: "claude-opus-5",
    sessionKey: "dao:stable-session",
    settings: { enabled: true, openaiMode: "implicit" },
  }));
  assert.deepStrictEqual(
    implicitStable.body.messages,
    implicitSnapshot.messages,
    "implicit diagnostics must not reorder or rewrite Devin history",
  );
  assert.deepStrictEqual(implicitOriginal, implicitSnapshot, "the caller body remains immutable");
  assert.ok(
    implicitStable.diagnostics.stablePrefixChars > 2,
    "implicit mode must measure the real stable prefix instead of hashing {}",
  );
  assert.strictEqual(implicitStable.diagnostics.stableMessageCount, 4);
  assert.strictEqual(implicitStable.diagnostics.stableItemHashes.length, 4);
  assert.match(implicitStable.diagnostics.stablePrefixHash, /^[a-f0-9]{12}$/);
  assert.doesNotMatch(
    JSON.stringify(implicitStable.diagnostics),
    /stable system|stable task|safe result|stable-session|dao-agent-status/,
  );

  const ttlDowngrade = policy.observeFailure({
    providerId: hourPlan.providerId,
    protocol: "anthropic",
    status: 422,
    body: "cache_control.ttl is not supported",
  });
  assert.deepStrictEqual(ttlDowngrade, {
    retry: true,
    feature: "anthropic-1h",
  });
  const downgradedHour = policy.decorate({
    system: "system",
    messages: [{ role: "user", content: "stable" }],
  }, policy.plan({
    ...anthropicInput,
    settings: { enabled: true, anthropicTtl: "1h", minBreakpointTokens: 0 },
  }));
  assert.strictEqual(downgradedHour.body.system[0].cache_control.ttl, undefined);
  assert.strictEqual(downgradedHour.diagnostics.cacheTtl, "5m");
  assert.strictEqual(downgradedHour.diagnostics.cacheDowngrade, "anthropic-1h");

  assert.deepStrictEqual(policy.observeFailure({
    providerId: "unrelated",
    protocol: "openai-chat",
    status: 400,
    body: "invalid tool schema",
  }), { retry: false, feature: null });

  const warmPlan = policy.plan({
    ...chatInput,
    providerId: "warm|https://warm.invalid",
    settings: {
      enabled: true,
      openaiMode: "explicit",
      warmup: {
        enabled: true,
        afterMs: 240_000,
        minStableTokens: 100,
        maxPerHour: 1,
      },
    },
  });
  const warmDecorated = policy.decorate(originalChat, warmPlan);
  assert.ok(warmDecorated.warmupSnapshot);
  assert.strictEqual(warmDecorated.warmupSnapshot.messages.length, 2);
  assert.doesNotMatch(
    JSON.stringify(warmDecorated.warmupSnapshot),
    /<!--dao-agent-status-->/,
  );
  assert.strictEqual(policy.scheduleWarmup({
    plan: warmPlan,
    stableTokens: 200,
    snapshot: { protocol: "openai-chat", messages: [{ role: "system", content: "safe" }] },
  }), true);
  assert.strictEqual(scheduled.at(-1).delay, 240_000);
  assert.strictEqual(policy.scheduleWarmup({
    plan: warmPlan,
    stableTokens: 200,
    snapshot: { protocol: "openai-chat", messages: [{ role: "system", content: "new" }] },
  }), true);
  assert.strictEqual(cancelled.length, 1, "a newer real request replaces the timer");
  await scheduled.at(-1).fn();
  assert.strictEqual(warmups.length, 1);
  assert.deepStrictEqual(warmups[0], {
    protocol: "openai-chat",
    messages: [{ role: "system", content: "new" }],
  });
  warmups[0].messages[0].content = "mutated";
  now += 1_000;
  assert.strictEqual(policy.scheduleWarmup({
    plan: warmPlan,
    stableTokens: 200,
    snapshot: { protocol: "openai-chat", messages: [{ role: "system", content: "third" }] },
  }), true);
  await scheduled.at(-1).fn();
  assert.strictEqual(warmups.length, 1, "hourly budget suppresses the second warmup");
  assert.strictEqual(policy.scheduleWarmup({
    plan: warmPlan,
    stableTokens: 10,
    snapshot: { protocol: "openai-chat" },
  }), false);
  policy.dispose();
  assert.ok(cancelled.length >= 1);
  assert.strictEqual(policy.status().activeWarmups, 0);
  assert.doesNotMatch(JSON.stringify(policy.status()), /gateway\.invalid|session-a/);

  // ── 最小可缓存长度门槛 ──────────────────────────────────────────────
  // 依据：Anthropic 文档化的最小可缓存前缀（Sonnet 1024 / Opus·Haiku 4096
  // token）。低于该值时 provider **照常成功、按全价计费、静默不缓存**，
  // 于是那个 breakpoint 既没缓存又占掉一个槽位（每请求上限 4 个）。
  const gate = createPromptCachePolicy({ now: () => now });

  // A. 前缀太小 → 不浪费消息级 breakpoint
  const tiny = gate.decorate({
    model: "claude-opus-5",
    system: [{ type: "text", text: "s" }],
    messages: [
      { role: "user", content: "tiny" },
      { role: "user", content: "<!--dao-agent-status--> changing" },
    ],
  }, gate.plan({
    providerId: "opus|https://a.invalid",
    protocol: "anthropic",
    model: "claude-opus-5",
    settings: { enabled: true },
  }));
  assert.strictEqual(
    tiny.body.messages[0].content[0].cache_control,
    undefined,
    "sub-minimum prefix must not spend a message breakpoint",
  );

  // B. 前缀够大 → 正常打点（证明门槛不是「永远发红」）
  const big = gate.decorate({
    model: "claude-opus-5",
    system: [{ type: "text", text: "S".repeat(20_000) }], // ≈5000 token > 4096
    messages: [
      { role: "user", content: "stable" },
      { role: "user", content: "<!--dao-agent-status--> changing" },
    ],
  }, gate.plan({
    providerId: "opus|https://a.invalid",
    protocol: "anthropic",
    model: "claude-opus-5",
    settings: { enabled: true },
  }));
  assert.ok(
    big.body.messages[0].content[0].cache_control,
    "large prefix still gets a message breakpoint",
  );

  // C. system/tools 必须计入前缀规模：消息本身很小，但 tools 很大 →
  //    仍应打点。漏算独立字段会系统性低估前缀，白丢 0.1x 读取优惠。
  const viaTools = gate.decorate({
    model: "claude-sonnet-4-6",
    system: [{ type: "text", text: "s" }],
    tools: [{ name: "Big", input_schema: { type: "object", description: "D".repeat(8_000) } }],
    messages: [
      { role: "user", content: "tiny" },
      { role: "user", content: "<!--dao-agent-status--> changing" },
    ],
  }, gate.plan({
    providerId: "sonnet|https://a.invalid",
    protocol: "anthropic",
    model: "claude-sonnet-4-6",
    settings: { enabled: true },
  }));
  assert.ok(
    viaTools.body.messages[0].content[0].cache_control,
    "tools tokens count toward the cacheable prefix",
  );

  // D. 显式 minBreakpointTokens: 0 关闭门槛（保留旧行为做对照实验）
  const noGate = gate.decorate({
    model: "claude-opus-5",
    system: [{ type: "text", text: "s" }],
    messages: [
      { role: "user", content: "tiny" },
      { role: "user", content: "<!--dao-agent-status--> changing" },
    ],
  }, gate.plan({
    providerId: "opus|https://a.invalid",
    protocol: "anthropic",
    model: "claude-opus-5",
    settings: { enabled: true, minBreakpointTokens: 0 },
  }));
  assert.ok(
    noGate.body.messages[0].content[0].cache_control,
    "minBreakpointTokens: 0 restores the ungated behaviour",
  );

  // E. 模型分档：Sonnet 1024 / Opus 4096。同一份 ~2000 token 前缀，
  //    Sonnet 该打点，Opus 不该。
  const midPrefix = () => ({
    system: [{ type: "text", text: "S".repeat(8_000) }], // ≈2000 token
    messages: [
      { role: "user", content: "stable" },
      { role: "user", content: "<!--dao-agent-status--> changing" },
    ],
  });
  const sonnetMid = gate.decorate({ model: "claude-sonnet-4-6", ...midPrefix() }, gate.plan({
    providerId: "s|https://a.invalid", protocol: "anthropic",
    model: "claude-sonnet-4-6", settings: { enabled: true },
  }));
  const opusMid = gate.decorate({ model: "claude-opus-5", ...midPrefix() }, gate.plan({
    providerId: "o|https://a.invalid", protocol: "anthropic",
    model: "claude-opus-5", settings: { enabled: true },
  }));
  assert.ok(
    sonnetMid.body.messages[0].content[0].cache_control,
    "~2000 tokens clears the Sonnet 1024 minimum",
  );
  assert.strictEqual(
    opusMid.body.messages[0].content[0].cache_control,
    undefined,
    "~2000 tokens is below the Opus 4096 minimum",
  );

  // F. TTL 不参与缓存家族身份：只改 TTL，家族哈希必须不变，
  //    否则历史样本无法跨配置对比「调 TTL 有没有用」。
  const familyBody = () => ({
    model: "claude-opus-5",
    system: [{ type: "text", text: "S".repeat(20_000) }],
    messages: [{ role: "user", content: "stable" }],
  });
  const ttl5 = gate.decorate(familyBody(), gate.plan({
    providerId: "f|https://a.invalid", protocol: "anthropic",
    model: "claude-opus-5", settings: { enabled: true, anthropicTtl: "5m" },
  }));
  const ttl1h = gate.decorate(familyBody(), gate.plan({
    providerId: "f|https://a.invalid", protocol: "anthropic",
    model: "claude-opus-5", settings: { enabled: true, anthropicTtl: "1h" },
  }));
  assert.strictEqual(
    ttl5.diagnostics.cacheFamilyHash,
    ttl1h.diagnostics.cacheFamilyHash,
    "cacheFamilyHash must not depend on TTL",
  );
  assert.notStrictEqual(ttl5.diagnostics.cacheTtl, ttl1h.diagnostics.cacheTtl);

  // G. systemToolsHash 与 breakpoint 选择无关：仅追加尾部消息时它必须不变，
  //    这样才能把「上游改了前缀」和「我们划错了稳定段」分开归因。
  const base = gate.decorate(familyBody(), gate.plan({
    providerId: "g|https://a.invalid", protocol: "anthropic",
    model: "claude-opus-5", settings: { enabled: true },
  }));
  const appended = gate.decorate({
    ...familyBody(),
    messages: [
      { role: "user", content: "stable" },
      { role: "assistant", content: "new tail" },
    ],
  }, gate.plan({
    providerId: "g|https://a.invalid", protocol: "anthropic",
    model: "claude-opus-5", settings: { enabled: true },
  }));
  assert.strictEqual(
    base.diagnostics.systemToolsHash,
    appended.diagnostics.systemToolsHash,
    "systemToolsHash is stable when only the tail changes",
  );
  // 反例：改 system 必须让它变（否则它就是个恒定值，测不出任何东西）
  const changedSystem = gate.decorate({
    model: "claude-opus-5",
    system: [{ type: "text", text: "X".repeat(20_000) }],
    messages: [{ role: "user", content: "stable" }],
  }, gate.plan({
    providerId: "g|https://a.invalid", protocol: "anthropic",
    model: "claude-opus-5", settings: { enabled: true },
  }));
  assert.notStrictEqual(
    base.diagnostics.systemToolsHash,
    changedSystem.diagnostics.systemToolsHash,
    "systemToolsHash must change when system changes",
  );
  gate.dispose();

  console.log("prompt cache policy: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

"use strict";

// 回归: 缓存策略关闭/降级时, 必须剥净适配器可能已钉的裸 cache_control /
//   prompt_cache_breakpoint (常落在易变末条 agent-status)。否则每轮 1.25x 写
//   缓存且几乎不命中。

const assert = require("node:assert");
const policyMod = require("../vendor/外接api/core/prompt_cache_policy");
const { createPromptCachePolicy, stripCacheAnnotations } = policyMod;

// 模拟 Anthropic 适配器输出: system/tools/末条消息都被无条件钉了 cache_control
function anthropicBodyWithBreakpoints() {
  return {
    model: "claude-x",
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "t", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "<!--dao-agent-status-->volatile",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  };
}

function countCacheControl(body) {
  return JSON.stringify(body).split('"cache_control"').length - 1;
}

// ── stripCacheAnnotations 模块级导出: 全剥, 不改输入 ──
{
  const body = anthropicBodyWithBreakpoints();
  const before = countCacheControl(body);
  assert.ok(before >= 3, "fixture has breakpoints");
  const stripped = stripCacheAnnotations(body);
  assert.strictEqual(countCacheControl(stripped), 0, "all cache_control stripped");
  assert.strictEqual(countCacheControl(body), before, "input not mutated");
}

// ── decorate 关闭时剥净 (此前直接 clone 原样送出 → 泄漏裸断点) ──
{
  const policy = createPromptCachePolicy({});
  const plan = policy.plan({
    providerId: "p",
    protocol: "anthropic",
    model: "claude-x",
    settings: { enabled: false },
  });
  const out = policy.decorate(anthropicBodyWithBreakpoints(), plan);
  assert.strictEqual(
    countCacheControl(out.body),
    0,
    "disabled decorate strips adapter breakpoints",
  );
  assert.strictEqual(out.diagnostics.cacheMode, "off");
  policy.dispose();
}

// ── decorate 启用时仍正常打断点 (不因新分支误伤正常路径) ──
{
  const policy = createPromptCachePolicy({});
  const plan = policy.plan({
    providerId: "p",
    protocol: "anthropic",
    model: "claude-x",
    settings: { enabled: true, minBreakpointTokens: 0 },
  });
  const out = policy.decorate(anthropicBodyWithBreakpoints(), plan);
  assert.ok(
    countCacheControl(out.body) > 0,
    "enabled decorate still marks breakpoints",
  );
  // 易变末条 (agent-status) 不应被选为断点
  const lastMsg = out.body.messages[out.body.messages.length - 1];
  assert.ok(
    !JSON.stringify(lastMsg).includes('"cache_control"'),
    "volatile last message must not carry a breakpoint",
  );
  policy.dispose();
}

// ── 实例方法 stripCacheAnnotations 可用 ──
{
  const policy = createPromptCachePolicy({});
  assert.strictEqual(typeof policy.stripCacheAnnotations, "function");
  const stripped = policy.stripCacheAnnotations(anthropicBodyWithBreakpoints());
  assert.strictEqual(countCacheControl(stripped), 0);
  policy.dispose();
}

console.log("prompt cache disabled-strip selftest: PASS");

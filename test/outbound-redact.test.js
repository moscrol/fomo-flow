"use strict";

const assert = require("assert");
const redact = require("../vendor/外接api/core/outbound_redact");

// ── scanText: 高置信度密钥被脱敏 ──
{
  const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234567890";
  const r = redact.scanText(`here is my key ${secret} ok`, { mode: "redact" });
  assert.ok(r.changed, "openai key should be redacted");
  assert.ok(!r.text.includes(secret), "secret must not remain in text");
  assert.ok(r.text.includes("«redacted:openai_key»"), "placeholder present");
  assert.strictEqual(r.findings.find((f) => f.name === "openai_key").count, 1);
}

// ── monitor 模式: 只报不改 ──
{
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const r = redact.scanText(`aws ${secret}`, { mode: "monitor" });
  assert.ok(!r.changed, "monitor must not change text");
  assert.ok(r.text.includes(secret), "monitor keeps original text");
  assert.strictEqual(r.findings.length, 1, "monitor still reports finding");
  assert.strictEqual(r.findings[0].name, "aws_access_key_id");
}

// ── 邮箱默认关闭, 显式开启才命中 ──
{
  const off = redact.scanText("mail me at a@b.com", { mode: "redact" });
  assert.ok(!off.changed, "email disabled by default");
  const on = redact.scanText("mail me at a@b.com", {
    mode: "redact",
    enableRules: ["email"],
  });
  assert.ok(on.changed, "email redacted when explicitly enabled");
  assert.ok(on.text.includes("«redacted:email»"));
}

// ── redactMessages: 命中消息被 clone, 未命中消息保持原引用 (前缀稳定) ──
{
  const clean = { role: "system", content: "you are a helpful assistant" };
  const dirty = {
    role: "user",
    content: "my token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 thanks",
  };
  const messages = [clean, dirty];
  const r = redact.redactMessages(messages, { mode: "redact" });
  assert.ok(r.changed, "redactMessages reports change");
  assert.strictEqual(r.messages[0], clean, "clean message keeps identity (prefix stable)");
  assert.notStrictEqual(r.messages[1], dirty, "dirty message is cloned");
  assert.ok(!r.messages[1].content.includes("ghp_"), "github token removed");
  assert.strictEqual(dirty.content.includes("ghp_"), true, "original message not mutated");
}

// ── 无命中: 返回原数组引用 ──
{
  const messages = [{ role: "user", content: "hello world, no secrets here" }];
  const r = redact.redactMessages(messages, { mode: "redact" });
  assert.ok(!r.changed);
  assert.strictEqual(r.messages, messages, "unchanged returns same array reference");
}

// ── block 模式: 命中即 blocked, 正文不改 ──
{
  const messages = [{ role: "user", content: "key sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX" }];
  const r = redact.redactMessages(messages, { mode: "block" });
  assert.ok(r.blocked, "block mode flags blocked on finding");
  assert.strictEqual(r.messages, messages, "block mode leaves messages untouched");
  assert.ok(r.findings.some((f) => f.name === "anthropic_key"));
}

// ── array content parts 与 tool_call arguments 都被扫 ──
{
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "run with sk-1234567890ABCDEFGHIJKLMNOP" },
        { type: "image_url", image_url: { url: "http://x/y.png" } },
      ],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: {
            name: "run",
            arguments: '{"env":"AWS=AKIAIOSFODNN7EXAMPLE"}',
          },
        },
      ],
    },
  ];
  const r = redact.redactMessages(messages, { mode: "redact" });
  assert.ok(r.changed);
  assert.ok(!JSON.stringify(r.messages[0].content).includes("sk-1234567890"));
  assert.ok(r.messages[0].content[1].type === "image_url", "non-text parts preserved");
  assert.ok(!r.messages[1].tool_calls[0].function.arguments.includes("AKIA"));
  JSON.parse(r.messages[1].tool_calls[0].function.arguments);
}

// ── google oauth token (ya29.) 默认开启 ──
{
  const token = "ya29.a0AfH6SMBx1234567890abcdefghijklmnop";
  const r = redact.scanText(`token: ${token}`, { mode: "redact" });
  assert.ok(r.changed, "ya29 token redacted by default");
  assert.ok(!r.text.includes("ya29."), "token removed");
  assert.strictEqual(r.findings[0].name, "google_oauth_token");
}

// ── credential_kv 默认关闭 (误报高), 显式开启才命中 ──
{
  const text = 'config: password: "hunter2secret!" end';
  const off = redact.scanText(text, { mode: "redact" });
  assert.ok(!off.changed, "credential_kv disabled by default");
  const on = redact.scanText(text, { mode: "redact", enableRules: ["credential_kv"] });
  assert.ok(on.changed, "credential_kv redacted when explicitly enabled");
  assert.ok(!on.text.includes("hunter2secret"), "kv value removed");
  assert.strictEqual(on.findings[0].name, "credential_kv");
}

// ── resolveSettings: per-route 覆盖全局 ──
{
  const g = { outboundRedact: { enabled: true, mode: "monitor" } };
  const route = { outboundRedact: { mode: "redact" } };
  const s = redact.resolveSettings(g, route);
  assert.strictEqual(s.enabled, true, "inherits enabled from global");
  assert.strictEqual(s.mode, "redact", "route mode overrides global");
  const none = redact.resolveSettings({}, {});
  assert.strictEqual(none.enabled, false, "disabled by default");
}

console.log("outbound redact selftest: PASS");

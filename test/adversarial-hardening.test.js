"use strict";

// 对抗性审查落地: 脱敏 block 真拦、关路由真关、resource 块也扫、预算不再双重扣减。

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAugmentation } = require("../vendor/外接api/core/acp_augment");
const { createAcpProxy } = require("../vendor/外接api/core/acp_proxy");
const budget = require("../vendor/外接api/core/budget");

const SECRET = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234567890";

function sink() {
  const lines = [];
  return {
    write: (s) => {
      lines.push(s);
      return true;
    },
    msgs: () =>
      lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}
function source() {
  const h = {};
  return {
    on: (e, fn) => {
      h[e] = fn;
    },
    feed: (s) => h.data && h.data(Buffer.from(s)),
    end: () => h.end && h.end(),
  };
}
function promptLine(text, id, extraBlocks) {
  const prompt = [{ type: "text", text }, ...(extraBlocks || [])];
  return (
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId: "s", prompt },
    }) + "\n"
  );
}

// ── block 模式: 不转发下游, 回编辑器 refusal ──
{
  const editorIn = source();
  const toAgent = sink();
  const toEditor = sink();
  const aug = createAugmentation({ redact: true, redactMode: "block" });
  createAcpProxy({
    editorIn,
    editorOut: toEditor,
    agentIn: toAgent,
    agentOut: source(),
    transformOutbound: aug.transformOutbound,
  }).start();
  editorIn.feed(promptLine(`leak ${SECRET}`, 7));
  assert.strictEqual(toAgent.msgs().length, 0, "block mode must not forward secret");
  const replies = toEditor.msgs();
  const result = replies.find((m) => m.id === 7);
  assert.ok(result && result.result.stopReason === "refusal", "editor gets refusal, not hang");
  assert.ok(
    replies.some((m) => /出站脱敏/.test(JSON.stringify(m))),
    "explanation chunk mentions redact",
  );
}

// ── resource.text 块也被脱敏 ──
{
  const a = createAugmentation({ redact: true });
  const msg = {
    jsonrpc: "2.0",
    id: 1,
    method: "session/prompt",
    params: {
      sessionId: "s",
      prompt: [
        { type: "text", text: "see attached" },
        { type: "resource", resource: { text: `key ${SECRET}` } },
      ],
    },
  };
  const out = a.transformOutbound(msg);
  assert.ok(!JSON.stringify(out).includes(SECRET), "resource.text secret redacted");
}

// ── 预算: history 桶不再被 system/reserve 二次扣减 ──
{
  const longUser = "hist-".repeat(200);
  const r = budget.apply({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: longUser },
    ],
    tools: [],
    system: "sys",
    budget: {
      maxContextTokens: 1000,
      historyBudgetRatio: 0.6,
      reserveRatio: 0.15,
      systemBudgetRatio: 0.1,
      toolsBudgetRatio: 0.15,
    },
    modelUid: "gpt-test",
  });
  // 双重扣减时 availableForHistory ≈ 600-sys-reserve, 容易把这条 hist 裁掉;
  // 修正后 history 桶是 min(600, leftover) ≈ 600, 一条短 hist 应保留。
  assert.ok(
    r.messages.some((m) => String(m.content || "").includes("hist-")),
    "history that fits the history bucket is not over-trimmed",
  );
  assert.ok(r.stats.availableForHistory > 400, "history budget not double-counted");
}

// ── hotSetConfig({daoRoutes:{enabled:false}}) 真的关掉 shouldRoute ──
{
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-hotdisable-"));
  const cfgPath = path.join(tempHome, "config.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      providers: {
        p: {
          enabled: true,
          apiKey: "k",
          baseUrl: "https://example/v1",
          models: ["m"],
          type: "openai-compatible",
        },
      },
      daoRoutes: {
        enabled: true,
        agentStatus: { enabled: false },
        routes: { m: { provider: "p", model: "m" } },
      },
    }),
    "utf8",
  );
  const router = require("../vendor/外接api/core/dao_router");
  router.init({ log: () => {}, configPath: cfgPath });
  assert.strictEqual(router.shouldRoute("m"), true, "precondition: routing on");
  const r = router.hotSetConfig({ daoRoutes: { enabled: false } });
  assert.ok(r.ok);
  assert.strictEqual(router.hotGetConfig().daoRoutes.enabled, false);
  assert.strictEqual(
    router.shouldRoute("m"),
    false,
    "hot disable must stop routing",
  );
  fs.rmSync(tempHome, { recursive: true, force: true });
}

console.log("adversarial hardening selftest: PASS");

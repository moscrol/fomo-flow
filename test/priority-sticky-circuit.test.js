"use strict";

// priority 路由的「熔断宽限期粘性」折中:
//   常态(主渠道健康)严守 priority 原序; 仅当主渠道熔断【未恢复】时, 把健康的
//   会话粘性备用渠道插到主渠道之前(复用其已热缓存); 主渠道恢复即回到原序。

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dao-sticky-"));
const cfgPath = path.join(tempHome, "config.json");
fs.writeFileSync(
  cfgPath,
  JSON.stringify({
    providers: {
      provA: {
        enabled: true,
        apiKey: "k",
        baseUrl: "https://a.example/v1",
        models: ["m"],
        type: "openai-compatible",
      },
      provB: {
        enabled: true,
        apiKey: "k",
        baseUrl: "https://b.example/v1",
        models: ["m"],
        type: "openai-compatible",
      },
    },
    daoRoutes: {
      enabled: true,
      agentStatus: { enabled: false },
      routes: {
        m: {
          provider: "provA",
          model: "m",
          channelStrategy: "priority",
          channelPriority: [
            { provider: "provA", model: "m" },
            { provider: "provB", model: "m" },
          ],
        },
      },
    },
  }),
  "utf8",
);

const router = require("../vendor/外接api/core/dao_router");

try {
  router.init({ log: () => {}, configPath: cfgPath });
  const T = router._test;

  const target = {
    provider: "provA",
    model: "m",
    _routeUid: "m",
    channelStrategy: "priority",
    channelPriority: [
      { provider: "provA", model: "m" },
      { provider: "provB", model: "m" },
    ],
  };
  const callOpts = { _promptCacheKey: "sess-1" };

  T.clearUpstreamCircuit("provA", "m");
  T.clearUpstreamCircuit("provB", "m");

  // 模拟故障期曾成功走过备用渠道 provB → 记住会话亲和
  T.rememberConversationProvider(target, callOpts, { provider: "provB", model: "m" });
  const sticky = T.stickyConversationTarget(target, callOpts);
  assert.ok(sticky && sticky.provider === "provB", "affinity points to warm provB");

  // ── 常态: 主渠道健康 → 严守 priority, 首选 primary(不前插 sticky) ──
  let cands = T.buildDispatchCandidates(target, callOpts);
  assert.strictEqual(cands[0].source, "primary", "healthy primary stays first (priority intact)");
  assert.ok(
    !cands.some((c) => c.source === "sticky-circuit"),
    "no sticky-circuit prepend while primary healthy",
  );

  // ── 主渠道熔断未恢复 → sticky 备用渠道前插 ──
  //   strikeThreshold 默认 5, 需累计多次失败才真正熔断
  const _openCircuit = (prov) => {
    for (let i = 0; i < 8 && !T.getUpstreamCircuit(prov, "m"); i++) {
      T.openUpstreamCircuit(prov, "m", 503, "server error");
    }
  };
  _openCircuit("provA");
  assert.ok(T.getUpstreamCircuit("provA", "m"), "provA circuit is open");
  cands = T.buildDispatchCandidates(target, callOpts);
  assert.strictEqual(cands[0].source, "sticky-circuit", "circuit-open → warm sticky first");
  assert.strictEqual(cands[0].target.provider, "provB", "sticky candidate is the warm provB");
  assert.ok(
    cands.some((c) => c.source === "primary"),
    "primary still present as later candidate",
  );

  // ── 备用渠道也熔断 → 无健康 sticky 可插, 不前插 ──
  _openCircuit("provB");
  assert.ok(T.getUpstreamCircuit("provB", "m"), "provB circuit is open");
  cands = T.buildDispatchCandidates(target, callOpts);
  assert.ok(
    !cands.some((c) => c.source === "sticky-circuit"),
    "no prepend when sticky channel itself is circuit-broken",
  );
  T.clearUpstreamCircuit("provB", "m");

  // ── 主渠道熔断恢复 → 立即回到 priority 原序 ──
  T.clearUpstreamCircuit("provA", "m");
  // 亲和可能在上一步被清; 重新记一次以证明「恢复后即使有亲和也不前插」
  T.rememberConversationProvider(target, callOpts, { provider: "provB", model: "m" });
  cands = T.buildDispatchCandidates(target, callOpts);
  assert.strictEqual(cands[0].source, "primary", "recovered → primary first again (priority restored)");
  assert.ok(
    !cands.some((c) => c.source === "sticky-circuit"),
    "no sticky-circuit prepend after recovery",
  );

  console.log("priority sticky circuit-grace selftest: PASS");
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}
// init 的配置监听 + 熔断探活定时器会挂住事件循环 · 显式退出
process.exit(0);

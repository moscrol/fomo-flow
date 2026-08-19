"use strict";
/**
 * omniuplift.test.js · OmniRoute 三大借鉴功能集成测试
 * ═══════════════════════════════════════════════════════════════
 *
 *   1. SSE 早期心跳 (sse_keepalive.js)
 *   2. Adaptive thinking 出站守卫 (adaptive_thinking_guard.js)
 *   3. 加权评分式自动路由 (channel_scorer.js)
 *
 *   运行: node vendor/外接api/core/_omniuplift_selftest.js
 *   或:   node -e "require('./vendor/外接api/core/_omniuplift_selftest.js').run()"
 */

const path = require("path");
const assert = require("assert");

const SSE_KEEPALIVE = require(path.join(__dirname, "sse_keepalive.js"));
const THINKING_GUARD = require(path.join(__dirname, "adaptive_thinking_guard.js"));
const CHANNEL_SCORER = require(path.join(__dirname, "channel_scorer.js"));

function run() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  OmniRoute 三大借鉴功能 · 集成测试");
  console.log("═══════════════════════════════════════════════════════\n");

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // §1  SSE 早期心跳
  // ════════════════════════════════════════════════════════════════
  console.log("\n── §1  SSE 早期心跳 ──\n");

  test("createKeepalive 返回控制器对象", () => {
    const ka = SSE_KEEPALIVE.createKeepalive(
      { writableEnded: false, destroyed: false, write() {} },
      "openai-chat",
    );
    assert.strictEqual(typeof ka.start, "function");
    assert.strictEqual(typeof ka.stop, "function");
    assert.strictEqual(typeof ka.touch, "function");
    assert.strictEqual(typeof ka.isActive, "function");
    assert.strictEqual(ka.heartbeatCount, 0);
  });

  test("首字在 startDelay 内到达 → 不发心跳", () => {
    let frames = [];
    const fakeRes = {
      writableEnded: false,
      destroyed: false,
      write(chunk) { frames.push(String(chunk)); },
    };
    const ka = SSE_KEEPALIVE.createKeepalive(fakeRes, "openai-chat", {
      startDelayMs: 100,
      intervalMs: 50,
    });
    ka.start();
    ka.touch(); // 模拟首字立即到达
    assert.strictEqual(frames.length, 0, "no frames should be sent after early touch");
    assert.strictEqual(ka.isActive(), false, "keepalive should not be active");
  });

  testAsync("延迟首字 → 发心跳帧", async () => {
    return new Promise((resolve) => {
      let frames = [];
      const fakeRes = {
        writableEnded: false,
        destroyed: false,
        write(chunk) { frames.push(String(chunk)); },
      };
      const ka = SSE_KEEPALIVE.createKeepalive(fakeRes, "anthropic", {
        startDelayMs: 5,
        intervalMs: 20,
        maxDurationMs: 80,
      });
      ka.start();
      setTimeout(() => {
        ka.stop();
        assert.ok(frames.length > 0, "should have sent heartbeats");
        assert.ok(
          frames.every((f) => f.includes("event: ping")),
          "all frames should be ping events for anthropic",
        );
        resolve();
      }, 100);
    });
  });

  testAsync("OpenAI 格式心跳帧合法 (choices + delta)", async () => {
    return new Promise((resolve) => {
      let frames = [];
      const fakeRes = {
        writableEnded: false,
        destroyed: false,
        write(chunk) { frames.push(String(chunk)); },
      };
      const ka = SSE_KEEPALIVE.createKeepalive(fakeRes, "openai-chat", {
        startDelayMs: 5,
        intervalMs: 20,
        maxDurationMs: 60,
      });
      ka.start();
      setTimeout(() => {
        ka.stop();
        assert.ok(frames.length > 0);
        for (const f of frames) {
          const data = f.replace(/^data:\s*/, "").trim();
          const obj = JSON.parse(data);
          assert.ok(obj.choices, "OpenAI heartbeat must have choices");
          assert.strictEqual(obj.choices[0].delta.content, undefined, "no content");
          assert.strictEqual(obj.choices[0].finish_reason, null);
        }
        resolve();
      }, 80);
    });
  });

  test("disabled 时不会发心跳", () => {
    let frames = [];
    const ka = SSE_KEEPALIVE.createKeepalive(
      { writableEnded: false, destroyed: false, write(c) { frames.push(c); } },
      "openai-chat",
      { enabled: false },
    );
    ka.start();
    assert.strictEqual(frames.length, 0);
    assert.strictEqual(ka.isActive(), false);
  });

  // ════════════════════════════════════════════════════════════════
  // §2  Adaptive Thinking 出站守卫
  // ════════════════════════════════════════════════════════════════
  console.log("\n── §2  Adaptive Thinking 出站守卫 ──\n");

  test("adaptive 模型 + 旧格式 thinking:{type:enabled} → 转为 adaptive", () => {
    const body = {
      model: "claude-opus-4-6",
      thinking: { type: "enabled", budget_tokens: 16384 },
      messages: [],
    };
    const { body: result, converted } = THINKING_GUARD.guardRequest(body, "claude-opus-4-6");
    assert.strictEqual(converted, true);
    assert.strictEqual(result.thinking.type, "adaptive");
    assert.strictEqual(result.output_config.effort, "high");
  });

  test("adaptive 模型 + 已是 adaptive 格式 → 不转换", () => {
    const body = {
      model: "claude-sonnet-4-6",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    };
    const { converted } = THINKING_GUARD.guardRequest(body, "claude-sonnet-4-6");
    assert.strictEqual(converted, false);
  });

  test("非 adaptive 模型 (claude-sonnet-4-0) → 不处理", () => {
    const body = {
      model: "claude-sonnet-4-0",
      thinking: { type: "enabled", budget_tokens: 10000 },
    };
    const { converted } = THINKING_GUARD.guardRequest(body, "claude-sonnet-4-0");
    assert.strictEqual(converted, false);
  });

  test("JSON 字符串 body 也能正确转换", () => {
    const bodyStr = JSON.stringify({
      model: "claude-opus-4-7",
      thinking: { type: "enabled", budget_tokens: 2048 },
    });
    const { body: result, converted } = THINKING_GUARD.guardRequest(bodyStr, "claude-opus-4-7");
    assert.strictEqual(converted, true);
    const parsed = JSON.parse(result);
    assert.strictEqual(parsed.thinking.type, "adaptive");
    assert.strictEqual(parsed.output_config.effort, "low");
  });

  test("reasoning_effort 泄露到 Anthropic 路径 → 转入 output_config", () => {
    const body = { model: "claude-opus-5", reasoning_effort: "high" };
    const { body: result, converted } = THINKING_GUARD.guardRequest(body, "claude-opus-5");
    assert.strictEqual(converted, true);
    assert.strictEqual(result.output_config.effort, "high");
    assert.strictEqual(result.reasoning_effort, undefined);
  });

  test("budget_tokens 映射: 2048→low, 8192→medium, 16384→high", () => {
    for (const [budget, effort] of [[2048, "low"], [8192, "medium"], [16384, "high"]]) {
      const body = { model: "claude-opus-5", thinking: { type: "enabled", budget_tokens: budget } };
      const { body: result, converted } = THINKING_GUARD.guardRequest(body, "claude-opus-5");
      assert.strictEqual(converted, true);
      assert.strictEqual(result.output_config.effort, effort, `${budget} → ${effort}`);
    }
  });

  test("hasLegacyThinking 检测旧格式", () => {
    assert.ok(THINKING_GUARD.hasLegacyThinking(
      { thinking: { type: "enabled", budget_tokens: 10000 } },
      "claude-opus-4-6",
    ));
    assert.ok(!THINKING_GUARD.hasLegacyThinking(
      { thinking: { type: "adaptive" } },
      "claude-opus-4-6",
    ));
    assert.ok(!THINKING_GUARD.hasLegacyThinking(
      { thinking: { type: "enabled" } },
      "claude-sonnet-4-0",
    ));
  });

  // ════════════════════════════════════════════════════════════════
  // §3  加权评分式自动路由
  // ════════════════════════════════════════════════════════════════
  console.log("\n── §3  加权评分式自动路由 ──\n");

  test("无数据渠道 → 中性分数", () => {
    CHANNEL_SCORER.clearMetrics();
    const { score, breakdown } = CHANNEL_SCORER.scoreChannel(
      { provider: "p1", model: "m1" },
      { circuits: new Map() },
    );
    assert.ok(score > 0 && score <= 1, "score should be in (0, 1]");
    assert.ok(breakdown.health > 0.5, "no-data health should be neutral-high");
  });

  test("熔断渠道 → 0 分", () => {
    const circuits = new Map([["p2|m2", { until: Date.now() + 60000 }]]);
    const { score } = CHANNEL_SCORER.scoreChannel({ provider: "p2", model: "m2" }, { circuits });
    assert.strictEqual(score, 0);
  });

  test("成功渠道 → 三样本后健康分高 + 延迟分高", () => {
    CHANNEL_SCORER.clearMetrics();
    CHANNEL_SCORER.recordSuccess("good", "m", 400, 1500);
    CHANNEL_SCORER.recordSuccess("good", "m", 500, 2000);
    const sparse = CHANNEL_SCORER.scoreChannel(
      { provider: "good", model: "m" },
      { circuits: new Map() },
    );
    assert.strictEqual(sparse.breakdown.latency, 0.5);

    CHANNEL_SCORER.recordSuccess("good", "m", 450, 1800);
    const { breakdown } = CHANNEL_SCORER.scoreChannel(
      { provider: "good", model: "m" },
      { circuits: new Map() },
    );
    assert.ok(breakdown.health >= 0.9);
    assert.ok(breakdown.latency >= 0.8);
  });

  test("排序: 快渠道 > 慢渠道", () => {
    CHANNEL_SCORER.clearMetrics();
    CHANNEL_SCORER.recordSuccess("fast", "m", 300, 1000);
    CHANNEL_SCORER.recordFailure("slow", "m", 500);
    CHANNEL_SCORER.recordSuccess("slow", "m", 5000, 10000);
    const ranked = CHANNEL_SCORER.rankChannels(
      [{ provider: "fast", model: "m" }, { provider: "slow", model: "m" }],
      { circuits: new Map() },
    );
    assert.strictEqual(ranked[0].provider, "fast");
  });

  test("缓存亲和加分", () => {
    CHANNEL_SCORER.clearMetrics();
    const { score: withAffinity } = CHANNEL_SCORER.scoreChannel(
      { provider: "p5", model: "m5" },
      { circuits: new Map(), cacheAffinityProvider: "p5" },
    );
    const { score: noAffinity } = CHANNEL_SCORER.scoreChannel(
      { provider: "p5", model: "m5" },
      { circuits: new Map(), cacheAffinityProvider: "other" },
    );
    assert.ok(withAffinity > noAffinity);
  });

  test("429 限流 → 配额降权", () => {
    CHANNEL_SCORER.clearMetrics();
    CHANNEL_SCORER.recordSuccess("limited", "m", 500, 1000);
    CHANNEL_SCORER.recordFailure("limited", "m", 429);
    const { breakdown: before } = CHANNEL_SCORER.scoreChannel(
      { provider: "limited", model: "m" },
      { circuits: new Map() },
    );
    // 配额应该被降低
    assert.ok(before.quota < 0.7, "quota should be reduced after 429");
  });

  test("连续成功 → 稳定性递增", () => {
    CHANNEL_SCORER.clearMetrics();
    CHANNEL_SCORER.recordSuccess("stable", "m", 500, 1000);
    const { breakdown: r1 } = CHANNEL_SCORER.scoreChannel(
      { provider: "stable", model: "m" },
      { circuits: new Map() },
    );
    CHANNEL_SCORER.recordSuccess("stable", "m", 500, 1000);
    CHANNEL_SCORER.recordSuccess("stable", "m", 500, 1000);
    const { breakdown: r3 } = CHANNEL_SCORER.scoreChannel(
      { provider: "stable", model: "m" },
      { circuits: new Map() },
    );
    assert.ok(r3.stability > r1.stability, "stability should increase with consecutive success");
  });

  test("metricsSummary 返回快��", () => {
    CHANNEL_SCORER.clearMetrics();
    CHANNEL_SCORER.recordSuccess("sum", "m", 500, 1000);
    const summary = CHANNEL_SCORER.metricsSummary();
    assert.ok(summary["sum|m"]);
    assert.strictEqual(summary["sum|m"].successCount, 1);
  });

  test("clearMetricsFor 只清指定渠道", () => {
    CHANNEL_SCORER.clearMetrics();
    CHANNEL_SCORER.recordSuccess("keep", "m", 500, 1000);
    CHANNEL_SCORER.recordSuccess("purge", "m", 500, 1000);
    CHANNEL_SCORER.clearMetricsFor("purge");
    const summary = CHANNEL_SCORER.metricsSummary();
    assert.ok(summary["keep|m"]);
    assert.ok(!summary["purge|m"]);
  });

  // ════════════════════════════════════════════════════════════════
  // §4  集成验证 (模块互操作)
  // ════════════════════════════════════════════════════════════════
  console.log("\n── §4  集成验证 ──\n");

  test("三大模块均可独立 require 且无副作用", () => {
    // 重复 require 不报错
    delete require.cache[require.resolve(path.join(__dirname, "sse_keepalive.js"))];
    delete require.cache[require.resolve(path.join(__dirname, "adaptive_thinking_guard.js"))];
    delete require.cache[require.resolve(path.join(__dirname, "channel_scorer.js"))];
    const ka = require(path.join(__dirname, "sse_keepalive.js"));
    const tg = require(path.join(__dirname, "adaptive_thinking_guard.js"));
    const cs = require(path.join(__dirname, "channel_scorer.js"));
    assert.strictEqual(typeof ka.createKeepalive, "function");
    assert.strictEqual(typeof tg.guardRequest, "function");
    assert.strictEqual(typeof cs.rankChannels, "function");
  });

  test("守卫 + 评分器联合: adaptive 模型在评分排序后仍被守卫", () => {
    CHANNEL_SCORER.clearMetrics();
    // 模拟候选渠道中有 adaptive 模型
    const candidates = [
      { provider: "p1", model: "claude-opus-4-6" },
      { provider: "p2", model: "claude-sonnet-4-6" },
    ];
    const ranked = CHANNEL_SCORER.rankChannels(candidates, { circuits: new Map() });
    // 对排名最高的候选做守卫检查
    const top = ranked[0];
    const fakeBody = { model: top.model, thinking: { type: "enabled", budget_tokens: 10000 } };
    const { converted, body: result } = THINKING_GUARD.guardRequest(fakeBody, top.model);
    assert.strictEqual(converted, true);
    assert.strictEqual(result.thinking.type, "adaptive");
  });

  // ════════════════════════════════════════════════════════════════
  // 总结
  // ════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  结果: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════════\n");

  if (failed > 0) {
    process.exitCode = 1;
  }
}

// 直接运行时自动执行
if (require.main === module) {
  run();
}

module.exports = { run };

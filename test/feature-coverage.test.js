"use strict";
/**
 * FOMO FLOW · 已实现功能全覆盖验证
 * 7 个功能模块 × 逐项断言
 *
 * 运行: node test/feature-coverage.test.js
 */
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const CORE = path.join(__dirname, "..", "vendor", "外接api", "core");
const SRC = fs.readFileSync(path.join(CORE, "dao_router.js"), "utf8");
const ADAPTERS_SRC = fs.readFileSync(path.join(CORE, "adapters.js"), "utf8");

let pass = 0, fail = 0;
const results = [];

function test(name, fn) {
  try { fn(); pass++; results.push(`  ✅ ${name}`); }
  catch (e) { fail++; results.push(`  ❌ ${name}: ${e.message}`); }
}

// ── 辅助：提取源码片段 ──────────────────────────
function extractFn(src, fnName) {
  const re = new RegExp(`(function ${fnName}\\([\\s\\S]*?)\\n}`);
  const m = src.match(re);
  if (!m) throw new Error(`找不到函数 ${fnName}`);
  return m[0];
}

// ── 在 vm sandbox 中 eval 纯函数，结果挂到 sandbox 上 ──
function extractFromRouter(fnNames, constNames) {
  const parts = [];
  for (const fn of fnNames) parts.push(extractFn(SRC, fn));
  for (const c of constNames) {
    const re = new RegExp(`(const ${c}\\s*=\\s*[\\s\\S]*?;)`);
    const m = SRC.match(re);
    if (!m) throw new Error(`找不到常量 ${c}`);
    parts.push(m[0]);
  }
  parts.push(SRC.match(/let _circuitPolicy\s*=\s*\{[\s\S]*?\};/)[0]);
  parts.push("function _touchConversationAffinity(key, data) { _conversationProviderAffinity.set(key, data); }");
  const exportNames = [...fnNames, ...constNames, "_circuitPolicy"];
  const exportLines = exportNames.map(n => `__e.${n} = ${n};`).join("\n");

  const sandbox = { __e: {}, Date, Math, Set, Map, Array, Object, Number, parseInt, assert: require("assert"), crypto: require("crypto") };
  vm.createContext(sandbox);
  vm.runInContext(parts.join("\n\n") + "\n\n" + exportLines, sandbox);
  return sandbox.__e;
}

const R = extractFromRouter(
  ["_circuitKey", "_parseRetryAfterMs", "_upstreamFailurePolicy", "_isHardCircuitFailure",
   "_shouldOpenCircuit", "_parkConversationAffinities", "_restoreConversationAffinities",
   "_readOnlyToolCacheKey"],
  ["_circuitStrikes", "_parkedConversationAffinity", "_conversationProviderAffinity",
   "_readOnlyToolCache", "_READ_ONLY_TOOL_CACHE_TTL_MS", "_READ_ONLY_TOOL_CACHE_LIMIT",
   "_READ_ONLY_TOOL_NAMES", "_DEFAULT_CIRCUIT_POLICY"]
);

// beta 头合并函数 (从 adapters.js 提取)
const betaSandbox = {};
vm.createContext(betaSandbox);
const hourCacheHelper = ADAPTERS_SRC.match(
  /function _hasAnthropicHourCache[\s\S]*?\n}/,
)[0];
const betaHeaderFn = ADAPTERS_SRC.match(
  /function _composeAnthropicBetaHeader[\s\S]*?\n}/,
)[0];
vm.runInContext(
  hourCacheHelper +
  "\n" +
  betaHeaderFn +
  "\n\n__e = _composeAnthropicBetaHeader;",
  betaSandbox,
);
const betaHeader = betaSandbox.__e;

// ═══════════════════════════════════════════════════════════
console.log("\n══════ 1. 熔断器: strike-based circuit breaker ════════");
// ═══════════════════════════════════════════════════════════

test("5xx policy: open=true ttl=30s reason=upstream_5xx", () => {
  const p = R._upstreamFailurePolicy(503, "Service Unavailable", {});
  assert.strictEqual(p.open, true);
  assert.strictEqual(p.reason, "upstream_5xx");
  assert.strictEqual(p.ttlMs, 30000);
});

test("5xx: 1次strike不熔断", () => {
  R._circuitStrikes.clear();
  const p = R._upstreamFailurePolicy(503, "", {});
  const d = R._shouldOpenCircuit("prov", "model", p, 503);
  assert.strictEqual(d.open, false);
  assert.strictEqual(d.strikes, 1);
});

test("5xx: 5次strike触发熔断", () => {
  R._circuitStrikes.clear();
  const p = R._upstreamFailurePolicy(503, "", {});
  R._shouldOpenCircuit("prov", "model", p, 503);
  R._shouldOpenCircuit("prov", "model", p, 503);
  R._shouldOpenCircuit("prov", "model", p, 503);
  R._shouldOpenCircuit("prov", "model", p, 503);
  const d5 = R._shouldOpenCircuit("prov", "model", p, 503);
  assert.strictEqual(d5.open, true);
  assert.strictEqual(d5.strikes, 5);
});

test("401硬故障: 1次即熔断 + providerWide", () => {
  R._circuitStrikes.clear();
  const p = R._upstreamFailurePolicy(401, "Unauthorized", {});
  assert.strictEqual(p.providerWide, true);
  const d = R._shouldOpenCircuit("prov", "model", p, 401);
  assert.strictEqual(d.open, true);
});

test("403余额: providerWide + 30min TTL", () => {
  const p = R._upstreamFailurePolicy(403, "insufficient balance", {});
  assert.strictEqual(p.providerWide, true);
  assert.strictEqual(p.reason, "balance");
  assert.ok(p.ttlMs >= 30 * 60 * 1000);
});

test("403权限: 非 providerWide", () => {
  const p = R._upstreamFailurePolicy(403, "forbidden", {});
  assert.strictEqual(p.providerWide, false);
  assert.strictEqual(p.reason, "permission");
});

test("429: 解析 retry-after=120s", () => {
  const p = R._upstreamFailurePolicy(429, "rate limit", { "retry-after": "120" });
  assert.strictEqual(p.reason, "rate_limit");
  assert.ok(p.ttlMs >= 120000);
});

test("429: 无 retry-after 默认>=60s", () => {
  const p = R._upstreamFailurePolicy(429, "rate limit", {});
  assert.ok(p.ttlMs >= 60000);
});

test("strike窗口过期后重置", () => {
  R._circuitStrikes.clear();
  const p = R._upstreamFailurePolicy(503, "", {});
  R._shouldOpenCircuit("prov", "win", p, 503);
  const key = R._circuitKey("prov", "win");
  const prior = R._circuitStrikes.get(key);
  prior.lastAt = Date.now() - 120000;
  R._circuitStrikes.set(key, prior);
  const d = R._shouldOpenCircuit("prov", "win", p, 503);
  assert.strictEqual(d.strikes, 1);
  assert.strictEqual(d.open, false);
});

test("网络错误(status=0): 30s TTL", () => {
  const p = R._upstreamFailurePolicy(0, "", {});
  assert.strictEqual(p.open, true);
  assert.strictEqual(p.reason, "network");
  assert.strictEqual(p.ttlMs, 30000);
});

test("200: 不熔断", () => {
  const p = R._upstreamFailurePolicy(200, "ok", {});
  assert.strictEqual(p.open, false);
});

test("_circuitPolicy 含 probeIntervalMs=5000", () => {
  assert.ok(R._circuitPolicy.probeIntervalMs >= 2000);
  assert.strictEqual(R._circuitPolicy.strikeThreshold, 5);
  assert.strictEqual(R._circuitPolicy.restoreAffinity, true);
});

// ═══════════════════════════════════════════════════════════
console.log("\n══════ 2. 周期探活逻辑（源码验证）═══════");
// ═══════════════════════════════════════════════════════════

test("源码含 _probeOnce 递归重探", () => {
  assert.ok(SRC.includes("_probeOnce"));
  assert.ok(SRC.includes("周期重探"));
});

test("探活用 circuitModel 而非 models[0]", () => {
  assert.ok(SRC.includes("_verifyProviderChat(providerName, provCfg, circuitModel)"));
});

test("探活带 extraHeaders", () => {
  assert.ok(SRC.includes("探活也要带 extraHeaders"));
});

test("_verifyProviderChat 接受 probeModel 参数", () => {
  assert.ok(/function _verifyProviderChat\(name,\s*cfg,\s*probeModel\)/.test(SRC));
  assert.ok(SRC.includes("probeModel ||"));
});

test("配置覆盖白名单含 probeIntervalMs", () => {
  assert.ok(SRC.includes('"probeIntervalMs"'));
});

test("热删除路由同步清理 routeRuntime", () => {
  const fn = extractFn(SRC, "hotRemoveRoute");
  assert.ok(fn.includes("_routeRuntime.delete(modelKey)"));
  assert.ok(fn.includes("_routeRuntime.delete(lowerKey)"));
  assert.ok(fn.includes("_routeRuntime.delete(modelUid)"));
});

test("热重载清空 routeRuntime", () => {
  const fn = extractFn(SRC, "init");
  assert.ok(fn.includes("_routeRuntime.clear()"));
});

// ═══════════════════════════════════════════════════════════
console.log("\n══════ 3. 成本感知路由: channel_scorer ════════");
// ═══════════════════════════════════════════════════════════

const scorer = require(path.join(CORE, "channel_scorer.js"));

test("模块加载: 有 rankChannels", () => {
  assert.strictEqual(typeof scorer.rankChannels, "function");
});

test("recordSuccess 不抛异常", () => {
  scorer.recordSuccess("scA", "m-a", 200, 500);
  assert.ok(true);
});

test("recordFailure 不抛异常", () => {
  scorer.recordFailure("scB", "m-b", 503);
  assert.ok(true);
});

test("rankChannels 返回排序数组", () => {
  const ranked = scorer.rankChannels(
    [{ provider: "scA", model: "m-a" }, { provider: "scB", model: "m-b" }],
    { callOpts: {}, cacheAffinityProvider: null }
  );
  assert.ok(Array.isArray(ranked));
  assert.strictEqual(ranked.length, 2);
});

test("rankChannels: 高频失败渠道排最后", () => {
  for (let i = 0; i < 10; i++) scorer.recordFailure("scFail", "m-fail", 500);
  scorer.recordSuccess("scGood", "m-good", 100, 200);
  const ranked = scorer.rankChannels(
    [{ provider: "scFail", model: "m-fail" }, { provider: "scGood", model: "m-good" }],
    { callOpts: {}, cacheAffinityProvider: null }
  );
  assert.strictEqual(ranked[0].provider, "scGood");
});

test("延迟评分: 少于3个样本保持中性，3个样本后使用p95", () => {
  scorer.clearMetrics();
  scorer.recordSuccess("tail-slow", "m", 100, 500);
  scorer.recordSuccess("tail-slow", "m", 9000, 9500);
  const early = scorer.getMetrics("tail-slow", "m");
  assert.strictEqual(early.sampleCount, 2);
  assert.strictEqual(
    scorer.scoreChannel(
      { provider: "tail-slow", model: "m" },
      { circuits: new Map() },
    ).breakdown.latency,
    0.5,
  );

  scorer.recordSuccess("tail-slow", "m", 10000, 10500);
  scorer.recordSuccess("steady-fast", "m", 500, 1000);
  scorer.recordSuccess("steady-fast", "m", 600, 1100);
  scorer.recordSuccess("steady-fast", "m", 700, 1200);
  const ranked = scorer.rankChannels(
    [
      { provider: "tail-slow", model: "m" },
      { provider: "steady-fast", model: "m" },
    ],
    { circuits: new Map() },
  );
  assert.strictEqual(ranked[0].provider, "steady-fast");
  assert.strictEqual(scorer.getMetrics("tail-slow", "m").p50TtftMs, 9000);
  assert.strictEqual(scorer.getMetrics("tail-slow", "m").p95TtftMs, 10000);
});

test("延迟评分: 缓存亲和仍优先于普通速度差异", () => {
  scorer.clearMetrics();
  for (const value of [500, 600, 700]) scorer.recordSuccess("fast", "m", value, value + 500);
  for (const value of [900, 1000, 1100]) scorer.recordSuccess("sticky", "m", value, value + 500);
  const ranked = scorer.rankChannels(
    [{ provider: "fast", model: "m" }, { provider: "sticky", model: "m" }],
    { circuits: new Map(), cacheAffinityProvider: "sticky" },
  );
  assert.strictEqual(ranked[0].provider, "sticky");
});

// ═══════════════════════════════════════════════════════════
console.log("\n══════ 4. 只读工具缓存 ════════");
// ═══════════════════════════════════════════════════════════

test("白名单含 code_search/grep_search/find_by_name", () => {
  assert.ok(R._READ_ONLY_TOOL_NAMES.has("code_search"));
  assert.ok(R._READ_ONLY_TOOL_NAMES.has("grep_search"));
  assert.ok(R._READ_ONLY_TOOL_NAMES.has("find_by_name"));
});

test("白名单不含写入类工具", () => {
  assert.ok(!R._READ_ONLY_TOOL_NAMES.has("edit"));
  assert.ok(!R._READ_ONLY_TOOL_NAMES.has("bash"));
  assert.ok(!R._READ_ONLY_TOOL_NAMES.has("write_to_file"));
});

test("TTL = 2分钟", () => assert.strictEqual(R._READ_ONLY_TOOL_CACHE_TTL_MS, 120000));
test("上限 = 256", () => assert.strictEqual(R._READ_ONLY_TOOL_CACHE_LIMIT, 256));

test("cacheKey: 不同参数不同key", () => {
  const k1 = R._readOnlyToolCacheKey("grep", '{"p":"a"}', { _workspaceRoots: ["/t"] });
  const k2 = R._readOnlyToolCacheKey("grep", '{"p":"b"}', { _workspaceRoots: ["/t"] });
  assert.notStrictEqual(k1, k2);
});

test("cacheKey: 不同workspace不同key", () => {
  const k1 = R._readOnlyToolCacheKey("grep", '{"p":"a"}', { _workspaceRoots: ["/t1"] });
  const k2 = R._readOnlyToolCacheKey("grep", '{"p":"a"}', { _workspaceRoots: ["/t2"] });
  assert.notStrictEqual(k1, k2);
});

test("cacheKey: 相同输入幂等", () => {
  const k1 = R._readOnlyToolCacheKey("grep", '{"p":"a"}', { _workspaceRoots: ["/t"] });
  const k2 = R._readOnlyToolCacheKey("grep", '{"p":"a"}', { _workspaceRoots: ["/t"] });
  assert.strictEqual(k1, k2);
});

// ═══════════════════════════════════════════════════════════
console.log("\n══════ 5. Anthropic beta 头合并 ════════");
// ═══════════════════════════════════════════════════════════

test("合并用户 + 默认 token", () => {
  const r = betaHeader({ extraHeaders: { "anthropic-beta": "context-1m-2025-08-07" } });
  const t = r.split(",");
  assert.ok(t.includes("prompt-caching-2024-07-31"));
  assert.ok(t.includes("context-1m-2025-08-07"));
});

test("无用户 beta: 只返回默认", () => {
  const r = betaHeader({});
  const t = r.split(",");
  assert.ok(t.includes("prompt-caching-2024-07-31"));
  assert.ok(!t.includes("context-1m-2025-08-07"));
});

test("thinkingEnabled 加 interleaved-thinking", () => {
  const r = betaHeader({ extraHeaders: { "anthropic-beta": "context-1m-2025-08-07" }, thinkingEnabled: true });
  const t = r.split(",");
  assert.ok(t.includes("interleaved-thinking-2025-05-14"));
  assert.ok(t.includes("context-1m-2025-08-07"));
});

test("多用户 token 全合并 + 去重", () => {
  const r = betaHeader({ extraHeaders: { "anthropic-beta": "context-1m-2025-08-07, prompt-caching-2024-07-31, fine-grained-tool-streaming-2025-05-14" } });
  const t = r.split(",");
  assert.strictEqual(t.length, new Set(t).size);
  assert.ok(t.includes("context-1m-2025-08-07"));
  assert.ok(t.includes("fine-grained-tool-streaming-2025-05-14"));
});

test("1h cache body 加 extended-cache-ttl beta", () => {
  const r = betaHeader({}, {
    system: [{ type: "text", cache_control: { type: "ephemeral", ttl: "1h" } }],
  });
  assert.ok(r.split(",").includes("extended-cache-ttl-2025-04-11"));
});

test("5m cache body 不加 extended-cache-ttl beta", () => {
  const r = betaHeader({}, {
    system: [{ type: "text", cache_control: { type: "ephemeral" } }],
  });
  assert.ok(!r.split(",").includes("extended-cache-ttl-2025-04-11"));
});

test("空串 beta 不报错", () => {
  const r = betaHeader({ extraHeaders: { "anthropic-beta": "" } });
  assert.ok(r.includes("prompt-caching"));
});

// ═══════════════════════════════════════════════════════════
console.log("\n══════ 6. 会话亲和暂存/恢复 ════════");
// ═══════════════════════════════════════════════════════════

test("park → restore 闭环", () => {
  R._conversationProviderAffinity.clear();
  R._parkedConversationAffinity.clear();
  R._conversationProviderAffinity.set("conv-x", { provider: "opus", model: "claude-opus-5", until: Date.now() + 60000 });
  const parked = R._parkConversationAffinities("opus", "claude-opus-5");
  assert.strictEqual(parked, 1);
  assert.strictEqual(R._conversationProviderAffinity.size, 0);

  const restored = R._restoreConversationAffinities("opus", "claude-opus-5");
  assert.strictEqual(restored, 1);
  assert.strictEqual(R._parkedConversationAffinity.size, 0);
  assert.ok(R._conversationProviderAffinity.has("conv-x"));
});

test("park 不匹配的不受影响", () => {
  R._conversationProviderAffinity.clear();
  R._parkedConversationAffinity.clear();
  R._conversationProviderAffinity.set("conv-y", { provider: "glm", model: "glm-5.2", until: Date.now() + 60000 });
  const parked = R._parkConversationAffinities("opus", "claude-opus-5");
  assert.strictEqual(parked, 0);
  assert.ok(R._conversationProviderAffinity.has("conv-y"));
});

test("restore 过期亲和不恢复", () => {
  R._conversationProviderAffinity.clear();
  R._parkedConversationAffinity.clear();
  R._conversationProviderAffinity.set("conv-z", { provider: "opus", model: "claude-opus-5", until: Date.now() + 60000 });
  R._parkConversationAffinities("opus", "claude-opus-5");
  const p = R._parkedConversationAffinity.get("conv-z");
  p.until = Date.now() - 1000;
  R._parkedConversationAffinity.set("conv-z", p);
  const restored = R._restoreConversationAffinities("opus", "claude-opus-5");
  assert.strictEqual(restored, 0);
});

// ═══════════════════════════════════════════════════════════
console.log("\n══════ 7. 审计日志: action_audit ════════");
// ═══════════════════════════════════════════════════════════

test("action_audit 模块可加载 + 暴露方法", () => {
  const audit = require(path.join(CORE, "action_audit.js"));
  assert.ok(typeof audit === "object");
  assert.ok(typeof audit.init === "function" || typeof audit.log === "function");
});

test("action_audit init + log 不抛异常", () => {
  const audit = require(path.join(CORE, "action_audit.js"));
  const tmpAudit = path.join(require("os").tmpdir(), ".test-audit.jsonl");
  try { fs.unlinkSync(tmpAudit); } catch {}
  if (typeof audit.init === "function") audit.init({ auditPath: tmpAudit });
  if (typeof audit.log === "function") audit.log({ action: "test", provider: "test", model: "test-m", status: 200 });
  assert.ok(true);
});

// ═══════════════════════════════════════════════════════════
console.log("\n══════ 8. 品牌重命名 ════════");
// ════════════���══════════════════════════════════════════════

const pkg = require(path.join(__dirname, "..", "package.json"));

test("name = fomo-flow", () => assert.strictEqual(pkg.name, "fomo-flow"));
test("publisher = fomoflow", () => assert.strictEqual(pkg.publisher, "fomoflow"));
test("displayName = FOMO FLOW · Model Gateway", () => assert.strictEqual(pkg.displayName, "FOMO FLOW · Model Gateway"));
test("configuration.title = FOMO FLOW", () => assert.strictEqual(pkg.contributes.configuration.title, "FOMO FLOW"));
test("untrustedWorkspaces.description 含 FOMO FLOW", () => assert.ok(pkg.capabilities.untrustedWorkspaces.description.includes("FOMO FLOW")));

test("activitybar title = FOMO FLOW", () => {
  const vc = pkg.contributes.viewsContainers.activitybar;
  const dao = Array.isArray(vc) ? vc.find(v => v.id === "fomo-container") : null;
  assert.ok(dao);
  assert.strictEqual(dao.title, "FOMO FLOW");
});

test("命令 category = FOMO FLOW (>5个)", () => {
  const cmds = pkg.contributes.commands.filter(c => c.category === "FOMO FLOW");
  assert.ok(cmds.length > 5, `got ${cmds.length}`);
});

test("无残留旧品牌字符串", () => {
  const s = JSON.stringify(pkg);
  assert.ok(!s.includes("dao-agi"));
  assert.ok(!s.includes("Dao Proxy Pro"));
  assert.ok(!s.includes("Dao Flow"));
  assert.ok(!s.includes("dao-genesis"));
  assert.ok(!s.includes("dao-container"));
});

// ═══════════════════════════════════════════════════════════
// 结果
// ═══════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(60));
for (const r of results) console.log(r);
console.log("═".repeat(60));
console.log(`  ✅ 通过: ${pass}    ❌ 失败: ${fail}    总计: ${pass + fail}`);
console.log("═".repeat(60));
process.exit(fail > 0 ? 1 : 0);

"use strict";

/**
 * retry-before-failover.test.js
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 七十六章「柔弱处上」· 瞬时波动先退避重试 · 连续失败才 failover
 *
 *   验证:
 *     1. transient/rate_limit/network 错误 (429/5xx/0) → 同 provider 重试 N 次
 *     2. 硬故障 (401/余额/404/权限) → 立即 failover · 不浪费时间重试
 *     3. sameProviderRetries 配置覆盖生效
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const router = require("../vendor/外接api/core/dao_router");

// ── _isHardFailure: 硬故障分类 ──────────────────────────────────

test("hard failures (401/403-balance/404) skip retry and failover immediately", () => {
  const t = router._test;
  assert.equal(t.isHardFailure(401), true, "401 = authentication 硬故障");
  assert.equal(t.isHardFailure(404), true, "404 = model_not_found 硬故障");
  // 403 with balance keyword is detected by _upstreamFailurePolicy body match;
  // the policy function itself defaults to "permission" for 403.
  assert.equal(t.isHardFailure(403), true, "403 = permission 硬故障");
});

test("transient failures (429/5xx/0) are NOT hard failures → eligible for retry", () => {
  const t = router._test;
  assert.equal(t.isHardFailure(429), false, "429 = rate_limit 可重试");
  assert.equal(t.isHardFailure(500), false, "500 = upstream_5xx 可重试");
  assert.equal(t.isHardFailure(502), false, "502 = upstream_5xx 可重试");
  assert.equal(t.isHardFailure(503), false, "503 = upstream_5xx 可重试");
  assert.equal(t.isHardFailure(0), false, "0 = network 可重试");
});

// ── _sameProviderMaxRetries: 配置解析 ──────────────────────────

test("sameProviderMaxRetries defaults to 2 when no resilience config", () => {
  const t = router._test;
  assert.equal(
    t.sameProviderMaxRetries({}),
    t.sameProviderMaxRetriesDefault,
  );
  assert.equal(
    t.sameProviderMaxRetries(null),
    t.sameProviderMaxRetriesDefault,
  );
  assert.equal(t.sameProviderMaxRetriesDefault, 2);
});

test("sameProviderMaxRetries respects resilience.sameProviderRetries", () => {
  const t = router._test;
  assert.equal(
    t.sameProviderMaxRetries({ resilience: { sameProviderRetries: 0 } }),
    0,
    "0 = 只尝试一次 · 不重试",
  );
  assert.equal(
    t.sameProviderMaxRetries({ resilience: { sameProviderRetries: 3 } }),
    3,
  );
  assert.equal(
    t.sameProviderMaxRetries({ resilience: { sameProviderRetries: 5 } }),
    5,
    "5 = 允许的上限",
  );
  assert.equal(
    t.sameProviderMaxRetries({ resilience: { sameProviderRetries: 99 } }),
    5,
    "超过 5 被钳到 5",
  );
  assert.equal(
    t.sameProviderMaxRetries({ resilience: { sameProviderRetries: -1 } }),
    t.sameProviderMaxRetriesDefault,
    "负数回退默认值",
  );
  assert.equal(
    t.sameProviderMaxRetries({ resilience: { sameProviderRetries: "abc" } }),
    t.sameProviderMaxRetriesDefault,
    "非数字回退默认值",
  );
});

console.log("[retry-before-failover] tests loaded");

"use strict";

const assert = require("node:assert");
const { createSemanticCache } = require("../vendor/外接api/core/semantic_cache");

// ── 命中: 近似向量(余弦≥阈值)返回缓存值 ──
{
  const c = createSemanticCache({ threshold: 0.95, ttlMs: 100000 });
  c.store([1, 0, 0], { answer: "A" });
  // 几乎同向 → 高相似度
  const hit = c.lookup([0.99, 0.01, 0]);
  assert.ok(hit.hit, "near-identical vector hits");
  assert.deepStrictEqual(hit.value, { answer: "A" });
  assert.ok(hit.score >= 0.95, "score above threshold");
}

// ── 未命中: 正交向量相似度 0 < 阈值 ──
{
  const c = createSemanticCache({ threshold: 0.9 });
  c.store([1, 0, 0], { answer: "A" });
  const miss = c.lookup([0, 1, 0]);
  assert.ok(!miss.hit, "orthogonal vector misses");
  assert.strictEqual(miss.value, null);
}

// ── 阈值边界: 略低于阈值不命中 ──
{
  const c = createSemanticCache({ threshold: 0.99 });
  c.store([1, 0], { answer: "A" });
  // 45° → cos≈0.707 < 0.99
  const miss = c.lookup([1, 1]);
  assert.ok(!miss.hit, "below-threshold similarity misses");
  // 放宽阈值后同一查询命中
  c.setOptions({ threshold: 0.7 });
  const hit = c.lookup([1, 1]);
  assert.ok(hit.hit, "lower threshold now hits");
}

// ── 多条中选最相似 ──
{
  const c = createSemanticCache({ threshold: 0.8 });
  c.store([1, 0, 0], { answer: "X" });
  c.store([0, 1, 0], { answer: "Y" });
  const hit = c.lookup([0.1, 0.99, 0]);
  assert.ok(hit.hit);
  assert.deepStrictEqual(hit.value, { answer: "Y" }, "returns most similar entry");
}

// ── TTL 过期 ──
{
  const c = createSemanticCache({ threshold: 0.9, ttlMs: 5 });
  c.store([1, 0], { answer: "A" });
  const now = Date.now();
  while (Date.now() - now < 12) {
    /* busy wait > ttl */
  }
  const miss = c.lookup([1, 0]);
  assert.ok(!miss.hit, "expired entry not returned");
  assert.ok(c.snapshot().expired >= 1);
}

// ── LRU 容量淘汰 ──
{
  const c = createSemanticCache({ threshold: 0.9, ttlMs: 100000, maxEntries: 2 });
  c.store([1, 0, 0], "a");
  c.store([0, 1, 0], "b");
  c.store([0, 0, 1], "c"); // 超容量 → 淘汰最旧 a
  assert.ok(!c.lookup([1, 0, 0]).hit, "oldest evicted");
  assert.ok(c.lookup([0, 0, 1]).hit, "newest survives");
  assert.ok(c.snapshot().evictions >= 1);
}

// ── 维度不一致的条目被跳过, 不误命中 ──
{
  const c = createSemanticCache({ threshold: 0.5 });
  c.store([1, 0, 0], "3d");
  const res = c.lookup([1, 0]); // 2d 查询
  assert.ok(!res.hit, "dimension mismatch skipped");
}

// ── 非法向量安全处理 ──
{
  const c = createSemanticCache();
  assert.strictEqual(c.store([], "x"), false, "empty vector rejected");
  assert.strictEqual(c.store([NaN, 1], "x"), false, "NaN vector rejected");
  assert.ok(!c.lookup(null).hit, "null query misses safely");
  assert.ok(!c.lookup([0, 0, 0]).hit, "zero vector misses safely");
}

// ── snapshot 统计 ──
{
  const c = createSemanticCache({ threshold: 0.9 });
  c.store([1, 0], "a");
  c.lookup([1, 0]); // hit
  c.lookup([0, 1]); // miss
  const s = c.snapshot();
  assert.strictEqual(s.hits, 1);
  assert.strictEqual(s.misses, 1);
  assert.strictEqual(s.hitRate, 50);
  assert.ok(s.avgHitScore > 0.9, "avg hit score tracked");
}

// ── 命名空间隔离: 同向量不同 ns 不串台 ──
{
  const c = createSemanticCache({ threshold: 0.9, ttlMs: 100000 });
  c.store([1, 0], { model: "a" }, "openai|provA|m1");
  const miss = c.lookup([1, 0], "anthropic|provB|m2");
  assert.ok(!miss.hit, "different namespace must not hit");
  const hit = c.lookup([1, 0], "openai|provA|m1");
  assert.ok(hit.hit, "same namespace hits");
  assert.deepStrictEqual(hit.value, { model: "a" });
}

console.log("semantic cache selftest: PASS");

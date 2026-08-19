"use strict";

const assert = require("assert");
const { createExactCache } = require("../vendor/外接api/core/exact_cache");

// ── 基本 set/get 命中 ──
{
  const c = createExactCache({ maxEntries: 3, ttlMs: 10000 });
  const k = c.makeKey({ model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.strictEqual(c.get(k), null, "miss before set");
  c.set(k, { body: "cached" });
  assert.deepStrictEqual(c.get(k), { body: "cached" }, "hit after set");
  const s = c.snapshot();
  assert.strictEqual(s.hits, 1);
  assert.strictEqual(s.misses, 1);
  assert.strictEqual(s.entries, 1);
}

// ── 键的确定性: 属性顺序不同但语义相同 → 同键; 数组顺序不同 → 不同键 ──
{
  const c = createExactCache();
  const k1 = c.makeKey({ a: 1, b: 2, msgs: [{ role: "user", content: "x" }] });
  const k2 = c.makeKey({ b: 2, msgs: [{ content: "x", role: "user" }], a: 1 });
  assert.strictEqual(k1, k2, "key stable across object key order");
  const k3 = c.makeKey({ msgs: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] });
  const k4 = c.makeKey({ msgs: [{ role: "assistant", content: "y" }, { role: "user", content: "x" }] });
  assert.notStrictEqual(k3, k4, "message order must change the key");
}

// ── TTL 过期 ──
{
  const c = createExactCache({ ttlMs: 5 });
  const k = c.makeKey({ q: 1 });
  c.set(k, { v: 1 });
  const now = Date.now();
  while (Date.now() - now < 12) {
    /* busy wait > ttl */
  }
  assert.strictEqual(c.get(k), null, "expired entry returns null");
  assert.strictEqual(c.snapshot().expired, 1);
}

// ── LRU 容量淘汰: 超容量丢最旧 ──
{
  const c = createExactCache({ maxEntries: 2, ttlMs: 100000 });
  const ka = c.makeKey({ n: "a" });
  const kb = c.makeKey({ n: "b" });
  const kc = c.makeKey({ n: "c" });
  c.set(ka, 1);
  c.set(kb, 2);
  c.get(ka); // 触达 a → a 变新, b 变最旧
  c.set(kc, 3); // 超容量 → 淘汰 b
  assert.strictEqual(c.get(kb), null, "least-recently-used b evicted");
  assert.deepStrictEqual(c.get(ka), 1, "recently used a survives");
  assert.deepStrictEqual(c.get(kc), 3, "newest c survives");
  assert.ok(c.snapshot().evictions >= 1);
}

// ── setOptions 缩容立即淘汰 ──
{
  const c = createExactCache({ maxEntries: 5, ttlMs: 100000 });
  for (let i = 0; i < 5; i++) c.set(c.makeKey({ i }), i);
  assert.strictEqual(c.snapshot().entries, 5);
  c.setOptions({ maxEntries: 2 });
  assert.strictEqual(c.snapshot().entries, 2, "shrinking maxEntries evicts oldest");
}

console.log("exact cache selftest: PASS");

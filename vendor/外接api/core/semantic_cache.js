"use strict";
/**
 * semantic_cache.js · 语义近似缓存 (三层缓存之第二层)
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 六十三章「大小多少 · 报怨以德」· 形异而意同者 · 同报之
 *
 *   三层缓存分工 (省的钱互不重叠, 可相加):
 *     ① exact-match  (exact_cache.js)      请求 byte 级相同 → 回放 · $0 · 零风险
 *     ② semantic     (本模块)              语义近似(embedding 余弦≥阈值)→ 回放 · $0
 *     ③ provider prefix (prompt_cache_policy) 稳定前缀 → 上游折扣计费
 *
 *   本模块只做纯向量数学 + 有界存储, **不含 embedding 调用**:
 *   embedding 由调用方注入 (revproxy 侧调用户配置的 embeddings 端点),
 *   使模块零依赖、可确定性测试。
 *
 *   ⚠ 正确性: 语义缓存有假阳性风险 (阈值过松会「自信地答错」)。
 *   默认阈值保守 (0.95), 且默认关闭; 命中/未命中计数供调用方做 eval 监控。
 */

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_THRESHOLD = 0.95;

function createSemanticCache(opts = {}) {
  let maxEntries = _positiveInt(opts.maxEntries, DEFAULT_MAX_ENTRIES);
  let ttlMs = _positiveInt(opts.ttlMs, DEFAULT_TTL_MS);
  let threshold = _clampThreshold(opts.threshold, DEFAULT_THRESHOLD);
  // 保序 Map: entryId → { vec, norm, value, at }; 迭代首项为最旧 (LRU)
  const store = new Map();
  let nextId = 1;
  const stats = {
    hits: 0,
    misses: 0,
    stores: 0,
    evictions: 0,
    expired: 0,
    bestScoreSum: 0, // 命中时的相似度累加 · 供观测平均命中相似度
  };

  // 查询: 传入查询向量, 返回最相似且 ≥ 阈值的条目 (否则 miss)。
  //   O(N·D) 线性扫描 · N 受 maxEntries 上限约束 (默认 200) · 实践足够。
  function lookup(vec, ns) {
    const q = _asVector(vec);
    const namespace = ns == null ? "" : String(ns);
    if (!q) {
      stats.misses++;
      return { hit: false, score: 0, value: null };
    }
    const qNorm = _norm(q);
    if (qNorm === 0) {
      stats.misses++;
      return { hit: false, score: 0, value: null };
    }
    const now = Date.now();
    let bestId = null;
    let bestScore = -1;
    let bestValue = null;
    for (const [id, entry] of store) {
      if (now - entry.at > ttlMs) {
        store.delete(id);
        stats.expired++;
        continue;
      }
      if ((entry.ns || "") !== namespace) continue;
      if (entry.vec.length !== q.length) continue;
      const score = _cosine(q, qNorm, entry.vec, entry.norm);
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
        bestValue = entry.value;
      }
    }
    if (bestId !== null && bestScore >= threshold) {
      // LRU 触达: 挪到末尾
      const entry = store.get(bestId);
      store.delete(bestId);
      store.set(bestId, entry);
      stats.hits++;
      stats.bestScoreSum += bestScore;
      return { hit: true, score: bestScore, value: bestValue };
    }
    stats.misses++;
    return { hit: false, score: bestScore < 0 ? 0 : bestScore, value: null };
  }

  function store_(vec, value, ns) {
    const v = _asVector(vec);
    if (!v) return false;
    const norm = _norm(v);
    if (norm === 0) return false;
    const id = nextId++;
    store.set(id, {
      vec: v,
      norm,
      value,
      at: Date.now(),
      ns: ns == null ? "" : String(ns),
    });
    stats.stores++;
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
      stats.evictions++;
    }
    return true;
  }

  function clear() {
    store.clear();
  }

  function setOptions(next = {}) {
    if (next.maxEntries !== undefined) maxEntries = _positiveInt(next.maxEntries, maxEntries);
    if (next.ttlMs !== undefined) ttlMs = _positiveInt(next.ttlMs, ttlMs);
    if (next.threshold !== undefined) threshold = _clampThreshold(next.threshold, threshold);
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
      stats.evictions++;
    }
  }

  function snapshot() {
    const total = stats.hits + stats.misses;
    return {
      entries: store.size,
      maxEntries,
      ttlMs,
      threshold,
      hits: stats.hits,
      misses: stats.misses,
      stores: stats.stores,
      evictions: stats.evictions,
      expired: stats.expired,
      hitRate: total > 0 ? Math.round((stats.hits / total) * 1000) / 10 : 0,
      avgHitScore:
        stats.hits > 0 ? Math.round((stats.bestScoreSum / stats.hits) * 1000) / 1000 : 0,
    };
  }

  return { lookup, store: store_, clear, setOptions, snapshot };
}

function _asVector(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return null;
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const n = Number(vec[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

function _norm(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

function _cosine(a, aNorm, b, bNorm) {
  if (aNorm === 0 || bNorm === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (aNorm * bNorm);
}

function _positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function _clampThreshold(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

module.exports = {
  createSemanticCache,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  DEFAULT_THRESHOLD,
};

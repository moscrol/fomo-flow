"use strict";
/**
 * exact_cache.js · byte 级精确匹配响应缓存 (三层缓存之第一层)
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 六十三章「为无为 事无事」· 同问同答 · 不劳而functions
 *
 *   三层缓存分工 (行业共识 · 省的钱互不重叠可相加):
 *     ① exact-match  (本模块)   请求 byte 级相同 → 直接回放 · 跳过上游 · $0
 *     ② semantic     (未来)     语义近似 → 跳过上游 · 需 eval 监控
 *     ③ provider prefix (prompt_cache_policy.js) 稳定前缀 → 上游折扣计费
 *
 *   本模块只做 ①: 零正确性风险 (完全相同才命中), 对模板化/重复请求立省。
 *   有界 LRU + TTL, 纯内存, 零依赖。仅缓存非流式且无工具的成功响应
 *   (调用方负责判定 · 见 revproxy 接入)。
 */

const crypto = require("crypto");

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 分钟 · 与 provider 5m 缓存档对齐

function createExactCache(opts = {}) {
  let maxEntries = _positiveInt(opts.maxEntries, DEFAULT_MAX_ENTRIES);
  let ttlMs = _positiveInt(opts.ttlMs, DEFAULT_TTL_MS);
  // Map 保序 → 迭代首项即最旧 (LRU: 命中/写入都 delete+set 挪到末尾)
  const store = new Map();
  const stats = { hits: 0, misses: 0, stores: 0, evictions: 0, expired: 0 };

  function makeKey(parts) {
    // canonical: 稳定序列化 · 键名有序, 避免属性顺序抖动
    const canonical = _stableStringify(parts);
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  function get(key) {
    if (!key) return null;
    const entry = store.get(key);
    if (!entry) {
      stats.misses++;
      return null;
    }
    if (Date.now() - entry.at > ttlMs) {
      store.delete(key);
      stats.expired++;
      stats.misses++;
      return null;
    }
    // LRU 触达: 挪到末尾
    store.delete(key);
    store.set(key, entry);
    entry.hits++;
    stats.hits++;
    return entry.value;
  }

  function set(key, value) {
    if (!key) return false;
    if (store.has(key)) store.delete(key);
    store.set(key, { value, at: Date.now(), hits: 0 });
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
    if (next.maxEntries !== undefined)
      maxEntries = _positiveInt(next.maxEntries, maxEntries);
    if (next.ttlMs !== undefined) ttlMs = _positiveInt(next.ttlMs, ttlMs);
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
      hits: stats.hits,
      misses: stats.misses,
      stores: stats.stores,
      evictions: stats.evictions,
      expired: stats.expired,
      hitRate: total > 0 ? Math.round((stats.hits / total) * 1000) / 10 : 0,
    };
  }

  return { makeKey, get, set, clear, setOptions, snapshot };
}

function _positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// 确定性序列化: 对象按 key 排序递归, 数组保序 (消息顺序有意义, 不能排序)
function _stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(_stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + _stableStringify(value[k])).join(",") +
    "}"
  );
}

module.exports = { createExactCache, DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS };

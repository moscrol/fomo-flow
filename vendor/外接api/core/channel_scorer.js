"use strict";
/**
 * channel_scorer.js · 加权评分式自动路由 · 移植自 OmniRoute
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 第六十二章「道者萬物之注也 善人之葆也 不善人之所葆也」
 *         道者, 万物归焉 · 善择者得最优 · 评分以择优
 *
 *   问题: dao proxy 目前用「固定优先级候选链 + 熔断跳过」, 够用但不「择优」。
 *         渠道多了之后, 固定顺序不考虑实时健康/延迟/成本/缓存亲和。
 *
 *   解法: 给每个候选渠道算加权分, 按分数排序选择。
 *         因子(来自 OmniRoute auto 策略, 精简为 8 个核心因子):
 *           1. 健康度 (healthScore)     - 最近失败率 · 熔断 = 0
 *           2. 延迟 (latencyScore)      - 最近平均 TTFB 倒数
 *           3. 成本 (costScore)         - 免费渠道满分 · 付费按档位
 *           4. 缓存亲和 (cacheScore)    - 同会话上次用过的渠道加分
 *           5. 稳定性 (stabilityScore)  - 连续成功次数
 *           6. 配额余量 (quotaScore)    - 429 降权
 *           7. 任务契合 (taskScore)     - 流式/工具/推理 契合度
 *           8. 优先级 (priorityScore)   - 配置中的声明优先级
 *
 *   数据源: dao_router.js 已有的 _healthCache / failure_stats / 延迟采集
 *           本模块提供轻量内存态采集器, 由 dao_router 在每次请求后喂入。
 *
 *   零依赖 · 纯 Node.js · 与 dao_router.js / failure_stats.js / resilience.js 协同
 */

// ── 权重配置 (OmniRoute auto 策略因子映射) ──────────────────────
const WEIGHTS = Object.freeze({
  health: 0.25,       // 健康度 — 最重要: 熔断/失败率高直接拉黑
  latency: 0.15,      // 延迟 — TTFB 快的优先
  cost: 0.10,         // 成本 — 免费优先但不主导
  cacheAffinity: 0.15, // 缓存亲和 — 同会话保持同一渠道
  stability: 0.10,    // 稳定性 — 连续成功的渠道可信
  quota: 0.10,        // 配额 — 限流过的降权
  taskFit: 0.10,      // 任务契合 — 流式/推理能力匹配
  priority: 0.05,     // 声明优先级 — 作为兜底排序基准
});

function _normalizedWeights(weights) {
  if (!weights || typeof weights !== "object") return WEIGHTS;
  const entries = Object.entries(WEIGHTS).map(([factor, fallback]) => {
    const value = Number(weights[factor]);
    return [factor, Number.isFinite(value) && value >= 0 ? value : fallback];
  });
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return WEIGHTS;
  return Object.fromEntries(entries.map(([factor, value]) => [factor, value / total]));
}

// ── 内存态渠道指标采集器 ──────────────────────────────────────────
// provider|model → { latencyMs[], successCount, failCount, consecutiveSuccess,
//                    lastTTFB, lastSuccessAt, lastFailAt, quotaRemaining }

const _metrics = new Map();
const _MAX_LATENCY_SAMPLES = 20;
const _DECAY_MS = 5 * 60 * 1000; // 5 分钟窗口

function _metricKey(provider, model) {
  return `${provider || ""}|${model || "*"}`;
}

function _nearestRank(values, quantile) {
  const sorted = (Array.isArray(values) ? values : [])
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice()
    .sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

/**
 * 记录一次成功的请求指标
 * @param {string} provider
 * @param {string} model
 * @param {number} ttfbMs - 首字节延迟
 * @param {number} totalMs - 总延迟
 */
function recordSuccess(provider, model, ttfbMs, totalMs) {
  const key = _metricKey(provider, model);
  let m = _metrics.get(key);
  if (!m) {
    m = { latencyMs: [], successCount: 0, failCount: 0, consecutiveSuccess: 0, quotaRemaining: null };
    _metrics.set(key, m);
  }
  if (!m.latencyMs) m.latencyMs = [];
  if (ttfbMs > 0) {
    m.latencyMs.push(ttfbMs);
    if (m.latencyMs.length > _MAX_LATENCY_SAMPLES) m.latencyMs.shift();
  }
  m.successCount = (m.successCount || 0) + 1;
  m.consecutiveSuccess = (m.consecutiveSuccess || 0) + 1;
  m.lastTTFB = ttfbMs || m.lastTTFB || 0;
  m.lastSuccessAt = Date.now();
}

/**
 * 记录一次失败
 * @param {string} provider
 * @param {string} model
 * @param {number} status - HTTP 状态码
 */
function recordFailure(provider, model, status) {
  const key = _metricKey(provider, model);
  let m = _metrics.get(key);
  if (!m) {
    m = { latencyMs: [], successCount: 0, failCount: 0, consecutiveSuccess: 0, quotaRemaining: null };
    _metrics.set(key, m);
  }
  m.failCount = (m.failCount || 0) + 1;
  m.consecutiveSuccess = 0;
  m.lastFailAt = Date.now();
  if (status === 429) {
    // 限流 → 配额视为严重不足 (直接压到 ≤20%, 远低于无数据中性值 0.7)
    m.quotaRemaining = Math.min(m.quotaRemaining != null ? m.quotaRemaining : 100, 20);
  }
}

/**
 * 设置配额余量 (来自上游配额响应)
 */
function setQuota(provider, model, remaining) {
  const key = _metricKey(provider, model);
  let m = _metrics.get(key);
  if (!m) {
    m = { latencyMs: [], successCount: 0, failCount: 0, consecutiveSuccess: 0, quotaRemaining: null };
    _metrics.set(key, m);
  }
  m.quotaRemaining = remaining;
}

/**
 * 获取某渠道的指标快照
 */
function getMetrics(provider, model) {
  const key = _metricKey(provider, model);
  const m = _metrics.get(key);
  if (!m) return null;
  const now = Date.now();
  // 衰减: 5 分钟窗口外的数据降权
  const recentSuccess = m.lastSuccessAt && now - m.lastSuccessAt < _DECAY_MS;
  const recentFail = m.lastFailAt && now - m.lastFailAt < _DECAY_MS;
  const avgLatency = m.latencyMs && m.latencyMs.length
    ? m.latencyMs.reduce((a, b) => a + b, 0) / m.latencyMs.length
    : 0;
  const sampleCount = m.latencyMs ? m.latencyMs.length : 0;
  return {
    avgLatencyMs: avgLatency,
    sampleCount,
    p50TtftMs: _nearestRank(m.latencyMs, 0.5),
    p95TtftMs: _nearestRank(m.latencyMs, 0.95),
    lastTTFB: m.lastTTFB || 0,
    successCount: m.successCount || 0,
    failCount: m.failCount || 0,
    consecutiveSuccess: m.consecutiveSuccess || 0,
    quotaRemaining: m.quotaRemaining,
    recentSuccess,
    recentFail,
  };
}

// ── 核心评分 ──────────────────────────────────────────────────────

/**
 * 计算单个候选渠道的加权分数
 *
 * @param {object} candidate - { provider, model, ... } 候选渠道
 * @param {object} ctx - 评分上下文
 * @param {Map}    ctx.circuits - 熔断表 (circuitKey → circuit)
 * @param {string|null} ctx.cacheAffinityProvider - 缓存亲和的 provider (同会话上次用的)
 * @param {object} ctx.callOpts - 调用选项 (判断流式/工具/推理)
 * @param {number} ctx.declaredPriority - 声明优先级 (越小越高)
 * @returns {{ score: number, breakdown: object }}
 */
function scoreChannel(candidate, ctx) {
  ctx = ctx || {};
  const provider = candidate.provider || "";
  const model = candidate.model || "";
  const breakdown = {};

  // 1. 健康度 (0-1): 熔断 = 0, 否则基于成功率
  const circuitKey = `${provider}|${model}`;
  const circuitWildcard = `${provider}|*`;
  const circuits = ctx.circuits;
  let isCircuitOpen = false;
  if (circuits) {
    for (const key of [circuitKey, circuitWildcard]) {
      const c = circuits.get ? circuits.get(key) : circuits[key];
      if (c && c.until > Date.now()) { isCircuitOpen = true; break; }
    }
  }
  if (isCircuitOpen) {
    breakdown.health = 0;
  } else {
    const m = getMetrics(provider, model);
    if (!m || (m.successCount === 0 && m.failCount === 0)) {
      breakdown.health = 0.8; // 无数据 → 中性偏高 (给新渠道机会)
    } else {
      const total = m.successCount + m.failCount;
      breakdown.health = total > 0 ? m.successCount / total : 0.5;
      // 近期失败惩罚
      if (m.recentFail && !m.recentSuccess) breakdown.health *= 0.3;
    }
  }

  // 2. 延迟 (0-1): 至少3个真实首个可见信号后使用 p95，p50 只作稳定性护栏。
  const m = getMetrics(provider, model);
  if (m && m.sampleCount >= 3 && m.p95TtftMs > 0) {
    const tail = Math.max(0.05, Math.min(1, 1000 / m.p95TtftMs));
    const center = Math.max(0.05, Math.min(1, 500 / Math.max(1, m.p50TtftMs)));
    breakdown.latency = tail * 0.8 + center * 0.2;
  } else {
    breakdown.latency = 0.5; // 无数据中性
  }

  // 3. 成本 (0-1): 优先采用同批候选的真实每千 token 估算；缺价回退档位。
  // _estimatedCostPer1k = inPer1k * 0.7 + outPer1k * 0.3（保守的编码任务平均权重）
  if (candidate._estimatedCostPer1k != null && ctx.costRange && ctx.costRange.max > ctx.costRange.min) {
    const normalized = (candidate._estimatedCostPer1k - ctx.costRange.min) /
      (ctx.costRange.max - ctx.costRange.min);
    breakdown.cost = Math.max(0.1, 1 - normalized);
  } else if (candidate._estimatedCostPer1k === 0 || candidate._freeTier) {
    breakdown.cost = 1.0;
  } else {
    breakdown.cost = candidate._costTier === "premium" ? 0.2 : 0.5;
  }

  // 4. 缓存亲和 (0-1): 同会话上次用过的渠道 = 1.0
  breakdown.cacheAffinity =
    ctx.cacheAffinityProvider && ctx.cacheAffinityProvider === provider ? 1.0 : 0.3;

  // 5. 稳定性 (0-1): 连续成功次数
  if (m && m.consecutiveSuccess > 0) {
    breakdown.stability = Math.min(1, 0.3 + m.consecutiveSuccess * 0.1);
  } else {
    breakdown.stability = 0.3;
  }

  // 6. 配额 (0-1)
  if (m && m.quotaRemaining != null) {
    breakdown.quota = Math.min(1, m.quotaRemaining / 100);
  } else {
    breakdown.quota = 0.7; // 无数据中性偏高
  }

  // 7. 任务契合 (0-1): 流式/推理/工具能力匹配
  breakdown.taskFit = _scoreTaskFit(candidate, ctx.callOpts);

  // 8. 声明优先级 (0-1)
  const prio = ctx.declaredPriority != null ? ctx.declaredPriority : (candidate._priority || 0);
  breakdown.priority = 1.0 / (1.0 + prio);

  // ── 加权汇总 ──────────────────────────────────────────────────
  let score = 0;
  for (const [factor, weight] of Object.entries(_normalizedWeights(ctx.weights))) {
    score += (breakdown[factor] || 0) * weight;
  }

  // 熔断的渠道直接 0 分 (不被选中)
  if (isCircuitOpen) score = 0;

  return { score, breakdown };
}

function _scoreTaskFit(candidate, callOpts) {
  if (!callOpts) return 0.7;
  let fit = 0.5;
  // 流式请求 + 渠道支持流式
  if (callOpts.stream !== false) fit += 0.2;
  // 工具调用 + 渠道支持工具
  if (callOpts.tools && callOpts.tools.length > 0) fit += 0.15;
  // 推理请求 + 渠道支持推理
  if (callOpts.thinkingEnabled || callOpts.reasoningEffort) fit += 0.15;
  return Math.min(1, fit);
}

// ── 排序候选渠道 ──────────────────────────────────────────────────

/**
 * 对候选渠道列表评分并排序, 返回按分数降序排列的列表。
 *
 * @param {Array} candidates - [{ provider, model, ... }, ...]
 * @param {object} ctx - 评分上下文 (见 scoreChannel)
 * @returns {Array} [{ ...candidate, _score, _scoreBreakdown }, ...]
 */
function rankChannels(candidates, ctx) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const scored = candidates.map((c) => {
    const { score, breakdown } = scoreChannel(c, ctx);
    return { ...c, _score: score, _scoreBreakdown: breakdown };
  });
  scored.sort((a, b) => (b._score || 0) - (a._score || 0));
  return scored;
}

// ── 清理 ──────────────────────────────────────────────────────────

function clearMetrics() {
  _metrics.clear();
}

function clearMetricsFor(provider) {
  for (const key of Array.from(_metrics.keys())) {
    if (key.startsWith(`${provider}|`)) _metrics.delete(key);
  }
}

// ── 汇总 (面板诊断用) ─────────────────────────────────────────────

function metricsSummary() {
  const out = {};
  for (const [key, m] of _metrics.entries()) {
    const avgLatency = m.latencyMs && m.latencyMs.length
      ? Math.round(m.latencyMs.reduce((a, b) => a + b, 0) / m.latencyMs.length)
      : 0;
    out[key] = {
      avgLatencyMs: avgLatency,
      sampleCount: m.latencyMs ? m.latencyMs.length : 0,
      p50TtftMs: _nearestRank(m.latencyMs, 0.5),
      p95TtftMs: _nearestRank(m.latencyMs, 0.95),
      successCount: m.successCount || 0,
      failCount: m.failCount || 0,
      consecutiveSuccess: m.consecutiveSuccess || 0,
      quotaRemaining: m.quotaRemaining,
    };
  }
  return out;
}

// ── 自检 ──────────────────────────────────────────────────────────

function _selfTest() {
  const assert = require("assert");
  clearMetrics();

  // 测试 1: 无数据 → 中性分数
  {
    const { score, breakdown } = scoreChannel(
      { provider: "p1", model: "m1" },
      { circuits: new Map() },
    );
    assert.ok(score > 0, "score should be positive");
    assert.ok(breakdown.health > 0.5, "no-data health should be neutral-high");
    console.log("[channel_scorer] test 1 PASS: no-data score = " + score.toFixed(3));
  }

  // 测试 2: 熔断 → 0 分
  {
    const circuits = new Map([["p2|m2", { until: Date.now() + 60000 }]]);
    const { score } = scoreChannel(
      { provider: "p2", model: "m2" },
      { circuits },
    );
    assert.strictEqual(score, 0, "circuit-open should score 0");
    console.log("[channel_scorer] test 2 PASS: circuit-open score = 0");
  }

  // 测试 3: 成功记录 → 分数提高
  {
    clearMetrics();
    recordSuccess("p3", "m3", 500, 2000);
    recordSuccess("p3", "m3", 600, 2500);
    recordSuccess("p3", "m3", 700, 2800);
    const { score, breakdown } = scoreChannel(
      { provider: "p3", model: "m3" },
      { circuits: new Map() },
    );
    assert.ok(breakdown.health >= 0.9, "all-success health should be high");
    assert.ok(breakdown.latency >= 0.8, "500-600ms latency should score high");
    console.log("[channel_scorer] test 3 PASS: success score = " + score.toFixed(3) + " health=" + breakdown.health.toFixed(2));
  }

  // 测试 4: 排序
  {
    clearMetrics();
    recordSuccess("fast", "m", 300, 1000);
    recordFailure("slow", "m", 500);
    recordSuccess("slow", "m", 5000, 10000);
    const ranked = rankChannels(
      [
        { provider: "fast", model: "m" },
        { provider: "slow", model: "m" },
      ],
      { circuits: new Map() },
    );
    assert.strictEqual(ranked[0].provider, "fast", "fast provider should rank first");
    console.log("[channel_scorer] test 4 PASS: ranking correct (fast > slow)");
  }

  // 测试 5: 缓存亲和加分
  {
    clearMetrics();
    const { score: withAffinity } = scoreChannel(
      { provider: "p5", model: "m5" },
      { circuits: new Map(), cacheAffinityProvider: "p5" },
    );
    const { score: noAffinity } = scoreChannel(
      { provider: "p5", model: "m5" },
      { circuits: new Map(), cacheAffinityProvider: "other" },
    );
    assert.ok(withAffinity > noAffinity, "cache affinity should boost score");
    console.log("[channel_scorer] test 5 PASS: affinity boost " + withAffinity.toFixed(3) + " > " + noAffinity.toFixed(3));
  }

  console.log("[channel_scorer] ALL TESTS PASSED");
}

module.exports = {
  WEIGHTS,
  scoreChannel,
  rankChannels,
  recordSuccess,
  recordFailure,
  setQuota,
  getMetrics,
  clearMetrics,
  clearMetricsFor,
  metricsSummary,
  _selfTest,
};

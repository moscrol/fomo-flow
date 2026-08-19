/**
 * failure_stats.js · 失败模式统计
 *   按 渠道×错误类型 聚合: 哪个渠道老是什么错 · 一眼看出"该换渠道了"
 *   内存态 · 面板经 summary() 取数
 *
 * API:
 *   classify(status, error)        → kind (auth/rate_limit/model_missing/server/timeout/network/other)
 *   record(provider, model, {status, error, kind}) → 记一笔
 *   summary()                      → { provider: {total, kinds, topKind, suggestion, lastAt} }
 *   clear()                        → 清空 (测试用)
 */
"use strict";

const _MAX_SAMPLES = 5;
const _stats = {}; // provider → { total, lastAt, kinds: { kind: {count, lastAt, lastModel, samples[]} } }

function classify(status, error) {
  const s = Number(status) || 0;
  const e = String(error || "").toLowerCase();
  if (s === 401 || s === 403) return "auth";
  if (s === 429) return "rate_limit";
  if (s === 404 && /model/.test(e)) return "model_missing";
  if (s === 404) return "not_found";
  if (s === 413) return "payload_too_large";
  if (s >= 500) return "server";
  if (s >= 400) return "client";
  if (/timeout|timed out|ttfb|stall/.test(e)) return "timeout";
  if (/econnrefused|econnreset|enotfound|socket|network|hang up/.test(e))
    return "network";
  return "other";
}

const _SUGGESTIONS = {
  auth: "API key 无效或过期 · 检查/更换该渠道 key",
  rate_limit: "频繁限流 · 建议降低并发或换渠道分流",
  model_missing: "模型不存在 · 检查该渠道模型名映射",
  server: "上游服务端频繁 5xx · 渠道不稳定 · 建议换渠道",
  timeout: "频繁超时 · 渠道链路慢 · 建议换渠道或加代理",
  network: "网络不可达 · 检查 baseUrl/代理/防火墙",
  payload_too_large: "请求过大被拒 · 调低上下文预算",
};

function record(provider, model, info) {
  if (!provider) return;
  const i = info && typeof info === "object" ? info : {};
  const kind = i.kind || classify(i.status, i.error);
  const now = Date.now();
  let p = _stats[provider];
  if (!p) p = _stats[provider] = { total: 0, lastAt: 0, kinds: {} };
  p.total += 1;
  p.lastAt = now;
  let k = p.kinds[kind];
  if (!k) k = p.kinds[kind] = { count: 0, lastAt: 0, lastModel: "", samples: [] };
  k.count += 1;
  k.lastAt = now;
  k.lastModel = model || "";
  k.samples.push({
    at: now,
    model: model || "",
    status: Number(i.status) || 0,
    error: String(i.error || "").slice(0, 200),
  });
  while (k.samples.length > _MAX_SAMPLES) k.samples.shift();
}

function summary() {
  const out = {};
  for (const [provider, p] of Object.entries(_stats)) {
    let topKind = "";
    let topCount = 0;
    const kinds = {};
    for (const [kind, k] of Object.entries(p.kinds)) {
      kinds[kind] = {
        count: k.count,
        lastAt: k.lastAt,
        lastModel: k.lastModel,
        samples: k.samples.map((s) => ({ ...s })),
      };
      if (k.count > topCount) {
        topCount = k.count;
        topKind = kind;
      }
    }
    out[provider] = {
      total: p.total,
      lastAt: p.lastAt,
      kinds,
      topKind,
      suggestion: _SUGGESTIONS[topKind] || "",
    };
  }
  return out;
}

function clear() {
  for (const k of Object.keys(_stats)) delete _stats[k];
}

module.exports = { classify, record, summary, clear };

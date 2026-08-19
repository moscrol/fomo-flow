/**
 * alert_center.js · 主动告警中心
 *   预算超限 / 渠道熔断(拉黑) / 全路由失败 等事件主动推送 ·
 *   面板可增量拉取 (since 游标) · 亦可 subscribe 即时回调 (弹通知)
 *
 * API:
 *   push({level, type, title, detail, provider, model}) → alert
 *   since(id, limit)   → id 之后的告警 (旧→新)
 *   recent(limit)      → 最近 N 条 (新→旧)
 *   subscribe(fn)      → 订阅新告警 · 返回退订函数
 *   clear()            → 清空 (测试用)
 */
"use strict";

const _MAX_ALERTS = 300;
const _DEDUP_WINDOW_MS = 60 * 1000; // 同 type+provider+model 60s 内去重 · 防告警风暴

const _alerts = [];
const _listeners = new Set();
let _seq = 0;

function push(input) {
  const a = input && typeof input === "object" ? input : {};
  const type = String(a.type || "generic");
  const provider = a.provider || "";
  const model = a.model || "";
  // 去重: 同类告警短窗内只报一次
  const now = Date.now();
  for (let i = _alerts.length - 1; i >= 0; i--) {
    const prev = _alerts[i];
    if (now - prev.at > _DEDUP_WINDOW_MS) break;
    if (prev.type === type && prev.provider === provider && prev.model === model) {
      prev.count = (prev.count || 1) + 1;
      prev.at = now;
      return prev;
    }
  }
  const alert = {
    id: ++_seq,
    at: now,
    level: a.level === "warn" || a.level === "info" ? a.level : "error",
    type,
    title: String(a.title || ""),
    detail: String(a.detail || ""),
    provider,
    model,
    count: 1,
  };
  _alerts.push(alert);
  while (_alerts.length > _MAX_ALERTS) _alerts.shift();
  for (const fn of _listeners) {
    try {
      fn(alert);
    } catch {}
  }
  return alert;
}

function since(id, limit) {
  const cursor = Number(id) || 0;
  const n = Math.max(1, Math.min(Number(limit) || 100, _MAX_ALERTS));
  return _alerts.filter((a) => a.id > cursor).slice(0, n).map((a) => ({ ...a }));
}

function recent(limit) {
  const n = Math.max(1, Math.min(Number(limit) || 50, _MAX_ALERTS));
  return _alerts.slice(-n).reverse().map((a) => ({ ...a }));
}

function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function clear() {
  _alerts.length = 0;
  _seq = 0;
}

module.exports = { push, since, recent, subscribe, clear };

/**
 * trace_center.js · 请求链路追踪
 *   每笔请求一条 trace: 路由选择 → 重试 → 换渠道 → 降级 的完整轨迹
 *   内存环形缓冲 · 不落盘 · 数据仅在本机
 *
 * API:
 *   begin(meta)          → trace 对象 (step/end 方法)
 *   recent(limit)        → 最近 N 条 trace (新→旧)
 *   clear()              → 清空 (测试用)
 */
"use strict";

const _MAX_TRACES = 200;
const _MAX_STEPS = 80;

const _traces = []; // 环形缓冲 · 尾部最新
let _seq = 0;
const _finishListeners = new Set(); // trace 完结回调 (OTEL 导出等 · 零侵入订阅)

// 订阅 trace 完结: end() 时以序列化 trace 触发。返回取消订阅函数。
function onFinish(cb) {
  if (typeof cb !== "function") return () => {};
  _finishListeners.add(cb);
  return () => _finishListeners.delete(cb);
}

function _emitFinish(trace) {
  if (_finishListeners.size === 0) return;
  const snapshot = _serialize(trace);
  for (const cb of _finishListeners) {
    try {
      cb(snapshot);
    } catch (_) {
      // 订阅者异常不影响主流程
    }
  }
}

function begin(meta) {
  const trace = {
    id: ++_seq,
    at: Date.now(),
    modelUid: (meta && meta.modelUid) || "",
    steps: [],
    status: "pending", // pending | ok | failed | skipped | error
    endedAt: null,
    durationMs: null,
    summary: "",
    step(type, detail) {
      if (this.steps.length >= _MAX_STEPS) return;
      this.steps.push({
        at: Date.now(),
        elapsedMs: Date.now() - this.at,
        type: String(type || ""),
        ...(detail && typeof detail === "object" ? detail : {}),
      });
    },
    end(status, summary) {
      if (this.endedAt) return;
      this.endedAt = Date.now();
      this.durationMs = this.endedAt - this.at;
      this.status = status || "ok";
      this.summary = summary || "";
      _emitFinish(this);
    },
  };
  _traces.push(trace);
  while (_traces.length > _MAX_TRACES) _traces.shift();
  return trace;
}

function _serialize(trace) {
  return {
    id: trace.id,
    at: trace.at,
    modelUid: trace.modelUid,
    status: trace.status,
    durationMs: trace.durationMs,
    summary: trace.summary,
    steps: trace.steps.map((s) => ({ ...s })),
  };
}

function recent(limit) {
  const n = Math.max(1, Math.min(Number(limit) || 50, _MAX_TRACES));
  return _traces.slice(-n).reverse().map(_serialize);
}

function clear() {
  _traces.length = 0;
}

module.exports = { begin, recent, clear, onFinish };

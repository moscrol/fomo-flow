"use strict";
/**
 * otel_export.js · OpenTelemetry 链路导出 (OTLP/HTTP · JSON)
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 十六章「致虚极也 守情表也 · 万物旁作 吾以观其复」· 观其复于外部之眼
 *
 *   定位: dao-flow 已有 trace_center(每请求 路由→重试→换渠道→降级 轨迹),
 *   补一个 OTLP 导出即可把这些 trace 送进用户现成的可观测后端
 *   (Jaeger/Tempo/Honeycomb/Grafana...), 与生态互操作。
 *
 *   零依赖: 手写 OTLP/HTTP JSON (resourceSpans), httpPost 依赖注入 → 可测。
 *   每条 trace → 1 个 span, 各 step 映射为 span event (保序 + 附属性)。
 *   有界缓冲 + 批量/定时 flush; 导出失败不影响主流程。
 */

const crypto = require("crypto");

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_BUFFER = 512;

function createOtelExporter(opts = {}) {
  const endpoint = String(opts.endpoint || "").replace(/\/$/, "");
  const serviceName = String(opts.serviceName || "fomo-flow");
  const headers = opts.headers && typeof opts.headers === "object" ? opts.headers : {};
  const httpPost = typeof opts.httpPost === "function" ? opts.httpPost : null;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const schedule = typeof opts.schedule === "function" ? opts.schedule : setInterval;
  const cancel = typeof opts.cancel === "function" ? opts.cancel : clearInterval;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const batchSize = _positiveInt(opts.batchSize, DEFAULT_BATCH_SIZE);
  const flushIntervalMs = _positiveInt(opts.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS);
  const maxBuffer = _positiveInt(opts.maxBuffer, DEFAULT_MAX_BUFFER);

  let buffer = [];
  let timer = null;
  let disposed = false;
  const stats = { exported: 0, failed: 0, dropped: 0, flushes: 0 };

  function _ensureTimer() {
    if (timer || disposed || !flushIntervalMs) return;
    timer = schedule(() => {
      flush().catch(() => {});
    }, flushIntervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  // 接收一条 (trace_center 序列化后的) trace, 转 OTLP span 入缓冲。
  function exportTrace(trace) {
    if (disposed || !trace) return;
    buffer.push(_traceToSpan(trace, now));
    if (buffer.length > maxBuffer) {
      buffer.splice(0, buffer.length - maxBuffer);
      stats.dropped++;
    }
    if (buffer.length >= batchSize) {
      flush().catch(() => {});
    } else {
      _ensureTimer();
    }
  }

  async function flush() {
    if (disposed || buffer.length === 0) return { ok: true, sent: 0 };
    const spans = buffer;
    buffer = [];
    stats.flushes++;
    const payload = JSON.stringify(_resourceSpans(spans, serviceName));
    if (!endpoint || !httpPost) {
      // 无端点/无传输 → 丢弃 (仅统计) · 不阻塞
      stats.dropped += spans.length;
      return { ok: false, sent: 0, reason: "no-endpoint" };
    }
    try {
      const url = endpoint.endsWith("/v1/traces") ? endpoint : endpoint + "/v1/traces";
      await httpPost(url, { "Content-Type": "application/json", ...headers }, payload);
      stats.exported += spans.length;
      return { ok: true, sent: spans.length };
    } catch (e) {
      stats.failed += spans.length;
      log("[otel] export failed: " + (e && e.message ? e.message : String(e)));
      return { ok: false, sent: 0, reason: "post-failed" };
    }
  }

  function snapshot() {
    return {
      endpoint: endpoint || null,
      buffered: buffer.length,
      exported: stats.exported,
      failed: stats.failed,
      dropped: stats.dropped,
      flushes: stats.flushes,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer) {
      try { cancel(timer); } catch (_) {}
      timer = null;
    }
    buffer = [];
  }

  return { exportTrace, flush, snapshot, dispose };
}

// ── OTLP 结构构造 ────────────────────────────────────────────────
function _resourceSpans(spans, serviceName) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [_attr("service.name", serviceName)],
        },
        scopeSpans: [
          {
            scope: { name: "dao-flow.trace_center" },
            spans,
          },
        ],
      },
    ],
  };
}

function _traceToSpan(trace, now) {
  const startMs = Number(trace.at) || now();
  const durationMs = Number(trace.durationMs) || 0;
  const endMs = startMs + durationMs;
  const status = String(trace.status || "ok");
  const attributes = [
    _attr("dao.model_uid", String(trace.modelUid || "")),
    _attr("dao.status", status),
    _attr("dao.trace_id", String(trace.id || "")),
    _attr("dao.summary", String(trace.summary || "")),
    _attrInt("dao.duration_ms", durationMs),
    _attrInt("dao.step_count", Array.isArray(trace.steps) ? trace.steps.length : 0),
  ];
  const events = (Array.isArray(trace.steps) ? trace.steps : []).map((step) => ({
    timeUnixNano: _ms2ns(Number(step.at) || startMs),
    name: String(step.type || "step"),
    attributes: _stepAttributes(step),
  }));
  // OTLP status code: UNSET=0, OK=1, ERROR=2
  const code = status === "failed" || status === "error" ? 2 : 1;
  return {
    traceId: _hex(16),
    spanId: _hex(8),
    name: "dao.route " + String(trace.modelUid || ""),
    kind: 3, // SPAN_KIND_CLIENT
    startTimeUnixNano: _ms2ns(startMs),
    endTimeUnixNano: _ms2ns(endMs),
    attributes,
    events,
    status: { code },
  };
}

function _stepAttributes(step) {
  const out = [];
  for (const key of Object.keys(step || {})) {
    if (key === "at" || key === "type" || key === "elapsedMs") continue;
    const v = step[key];
    if (typeof v === "number") out.push(_attrInt("dao." + key, v));
    else if (typeof v === "boolean") out.push({ key: "dao." + key, value: { boolValue: v } });
    else if (v != null) out.push(_attr("dao." + key, String(v)));
  }
  if (typeof step.elapsedMs === "number") out.push(_attrInt("dao.elapsed_ms", step.elapsedMs));
  return out;
}

function _attr(key, stringValue) {
  return { key, value: { stringValue } };
}
function _attrInt(key, n) {
  return { key, value: { intValue: Math.round(Number(n) || 0) } };
}
function _ms2ns(ms) {
  // 字符串表示纳秒, 避免 53-bit 精度丢失
  return String(Math.round(Number(ms) || 0)) + "000000";
}
function _hex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}
function _positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

module.exports = {
  createOtelExporter,
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
};

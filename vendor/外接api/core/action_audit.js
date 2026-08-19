/**
 * action_audit.js · 配置动作审计
 *   谁(哪个入口)在何时改了什么配置 · 结果如何 · 全链路可追溯
 *   内存环形缓冲 + JSONL 落盘 (配置同目录 .action-audit.jsonl) ·
 *   配合 config_history 一键回滚 · 误改可查可退
 *
 * API:
 *   init({auditPath})              → 设置落盘路径 (可选 · 不设仅内存)
 *   record({action, args, result, source}) → 记一笔 (args 自动脱敏 apiKey)
 *   recent(limit) / since(id)      → 查询
 *   clear()                        → 清空内存 (测试用)
 */
"use strict";

const fs = require("fs");

const _MAX_ENTRIES = 500;
const _entries = [];
let _seq = 0;
let _auditPath = null;

function init(opts) {
  _auditPath = (opts && opts.auditPath) || null;
}

// 脱敏: apiKey/token/password 字段只留前4后2
function _redact(value, depth) {
  if (depth > 6) return "[deep]";
  if (Array.isArray(value)) return value.map((v) => _redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/apikey|api_key|token|password|secret/i.test(k) && typeof v === "string") {
        out[k] = v.length > 8 ? `${v.slice(0, 4)}***${v.slice(-2)}` : "***";
      } else {
        out[k] = _redact(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500)
    return value.slice(0, 500) + "…";
  return value;
}

function record(input) {
  const a = input && typeof input === "object" ? input : {};
  const entry = {
    id: ++_seq,
    at: Date.now(),
    action: String(a.action || ""),
    source: String(a.source || "api"),
    args: _redact(a.args === undefined ? null : a.args, 0),
    ok: a.result && typeof a.result === "object" ? a.result.ok !== false : true,
    error:
      (a.result && typeof a.result === "object" && a.result.error) || undefined,
  };
  _entries.push(entry);
  while (_entries.length > _MAX_ENTRIES) _entries.shift();
  if (_auditPath) {
    try {
      fs.appendFile(_auditPath, JSON.stringify(entry) + "\n", () => {});
    } catch {}
  }
  return entry;
}

function recent(limit) {
  const n = Math.max(1, Math.min(Number(limit) || 50, _MAX_ENTRIES));
  return _entries.slice(-n).reverse().map((e) => ({ ...e }));
}

function since(id, limit) {
  const cursor = Number(id) || 0;
  const n = Math.max(1, Math.min(Number(limit) || 100, _MAX_ENTRIES));
  return _entries.filter((e) => e.id > cursor).slice(0, n).map((e) => ({ ...e }));
}

function clear() {
  _entries.length = 0;
  _seq = 0;
}

module.exports = { init, record, recent, since, clear };

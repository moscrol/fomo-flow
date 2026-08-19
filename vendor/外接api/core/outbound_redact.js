"use strict";
/**
 * outbound_redact.js · 出站敏感信息脱敏拦截阶段
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 六十四章「为之于其未有 治之于其未乱」· 秘于未泄之时先治
 *
 *   定位: dao-flow 是「介于 IDE 与 API 服务层之间的一张桌子」, 消息本就
 *         流经这张桌子。既然要经手, 就该在发往第三方 provider 之前把高置信
 *         度的密钥/凭证扫出来, 按策略 拦截 / 脱敏 / 仅记录。
 *
 *   设计原则:
 *     1. 纯函数, 零依赖, 不碰 fs/网络 —— 可被 dao_router 与 revproxy 复用。
 *     2. 默认只匹配高置信度密钥 (sk-/AKIA/私钥块/JWT…), 邮箱/路径默认关闭,
 *        因为编码 agent 合法地需要谈论路径与邮箱, 误伤代价高于漏检。
 *     3. 前缀稳定优先: 未命中 / monitor 模式时原样返回同一引用, 不破坏
 *        上游 prompt 缓存前缀。仅真正改写的消息才 clone。
 *     4. 三态动作: monitor(只报) / redact(脱敏) / block(命中即拒)。
 */

// ── 内置高置信度规则 (低误报) ────────────────────────────────
//   每条: { name, category, re(带 g flag), enabledByDefault }
//   re 必须是全局正则; 计数与替换都依赖 g flag。
const DEFAULT_RULES = [
  // anthropic 在前, 且 openai 用负向前瞻排除 sk-ant-, 避免 sk- 贪婪吞掉 anthropic key
  {
    name: "anthropic_key",
    category: "secret",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    enabledByDefault: true,
  },
  {
    name: "openai_key",
    category: "secret",
    re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    enabledByDefault: true,
  },
  {
    name: "aws_access_key_id",
    category: "secret",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    enabledByDefault: true,
  },
  {
    name: "google_api_key",
    category: "secret",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    enabledByDefault: true,
  },
  {
    name: "github_token",
    category: "secret",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    enabledByDefault: true,
  },
  {
    name: "slack_token",
    category: "secret",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    enabledByDefault: true,
  },
  {
    name: "private_key_block",
    category: "secret",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    enabledByDefault: true,
  },
  {
    name: "jwt",
    category: "secret",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    enabledByDefault: true,
  },
  {
    name: "bearer_token",
    category: "secret",
    re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}/g,
    enabledByDefault: true,
  },
  {
    name: "google_oauth_token",
    category: "secret",
    re: /\bya29\.[0-9A-Za-z_-]{20,}\b/g,
    enabledByDefault: true,
  },
  // 以下默认关闭: 对编码 agent 误伤大, 需显式开启
  {
    // 硬编码凭证 kv (password: "..." / api_key = '...'): 误报高, 显式开启才生效
    name: "credential_kv",
    category: "secret",
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
    enabledByDefault: false,
  },
  {
    name: "email",
    category: "pii",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    enabledByDefault: false,
  },
];

const DEFAULT_PLACEHOLDER = (name) => `«redacted:${name}»`;

function _rulesFor(opts) {
  const disabled = new Set(
    Array.isArray(opts.disableRules) ? opts.disableRules : [],
  );
  const enabled = new Set(Array.isArray(opts.enableRules) ? opts.enableRules : []);
  const base = DEFAULT_RULES.filter((rule) => {
    if (disabled.has(rule.name)) return false;
    if (enabled.has(rule.name)) return true;
    return rule.enabledByDefault;
  });
  // 用户自定义规则: { name, category?, pattern(string), flags? }
  const custom = [];
  for (const raw of Array.isArray(opts.customRules) ? opts.customRules : []) {
    if (!raw || !raw.name || !raw.pattern) continue;
    try {
      const flags = String(raw.flags || "g");
      const re = new RegExp(raw.pattern, flags.includes("g") ? flags : flags + "g");
      custom.push({ name: raw.name, category: raw.category || "custom", re });
    } catch (_) {
      // 非法正则忽略, 不因用户配置崩掉热路径
    }
  }
  return base.concat(custom);
}

/**
 * 扫描单段文本。
 * @returns {{ text, findings: Array<{name,category,count}>, changed:boolean }}
 */
function scanText(text, opts = {}) {
  const findings = [];
  if (typeof text !== "string" || !text) {
    return { text: text || "", findings, changed: false };
  }
  const rules = opts._rules || _rulesFor(opts);
  // monitor 与 block 都只检测、不改写 (block 由调用方拒绝整条请求)
  const monitorOnly = opts.mode === "monitor" || opts.mode === "block";
  const placeholder =
    typeof opts.placeholder === "function" ? opts.placeholder : DEFAULT_PLACEHOLDER;
  let out = text;
  let changed = false;
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let count = 0;
    if (monitorOnly) {
      // 只计数, 不改写
      while (rule.re.exec(out) !== null) {
        count++;
        if (rule.re.lastIndex === 0) break; // 防零宽匹配死循环
      }
    } else {
      out = out.replace(rule.re, () => {
        count++;
        return placeholder(rule.name);
      });
    }
    if (count > 0) {
      findings.push({ name: rule.name, category: rule.category, count });
      if (!monitorOnly) changed = true;
    }
  }
  return { text: out, findings, changed };
}

function _scanContent(content, opts, accFindings) {
  if (typeof content === "string") {
    const result = scanText(content, opts);
    result.findings.forEach((f) => accFindings.push(f));
    return { content: result.changed ? result.text : content, changed: result.changed };
  }
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const parts = content.map((part) => {
    if (part && typeof part.text === "string") {
      const result = scanText(part.text, opts);
      result.findings.forEach((f) => accFindings.push(f));
      if (result.changed) {
        changed = true;
        return { ...part, text: result.text };
      }
    }
    return part;
  });
  return { content: changed ? parts : content, changed };
}

function _redactJsonValue(value, opts, accFindings) {
  if (typeof value === "string") {
    const r = scanText(value, opts);
    r.findings.forEach((f) => accFindings.push(f));
    return { value: r.changed ? r.text : value, changed: r.changed };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const inner = _redactJsonValue(item, opts, accFindings);
      if (inner.changed) changed = true;
      return inner.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next = {};
    for (const k of Object.keys(value)) {
      const inner = _redactJsonValue(value[k], opts, accFindings);
      if (inner.changed) changed = true;
      next[k] = inner.value;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

// tool_calls[].function.arguments 必须保持合法 JSON。
//   能 parse → 只改 string 叶子再 stringify; 不能 parse → 只收集 findings, 不改写。
function _scanToolCallArgs(args, opts, accFindings) {
  if (typeof args !== "string" || !args) return { text: args, changed: false };
  try {
    const parsed = JSON.parse(args);
    const inner = _redactJsonValue(parsed, opts, accFindings);
    if (!inner.changed) return { text: args, changed: false };
    return { text: JSON.stringify(inner.value), changed: true };
  } catch (_) {
    const r = scanText(args, { ...opts, mode: "monitor" });
    r.findings.forEach((f) => accFindings.push(f));
    return { text: args, changed: false };
  }
}

/**
 * 扫描/脱敏一组 OpenAI Chat 形态消息 (出站前调用)。
 *
 * @param {Array} messages
 * @param {object} opts
 *   - mode: "monitor" | "redact" | "block" (默认 redact)
 *   - includeToolCallArgs: 是否扫 assistant.tool_calls[].function.arguments (默认 true)
 *   - enableRules / disableRules / customRules / placeholder
 * @returns {{ messages, findings, blocked, changed }}
 *   命中且 mode==="block" 时 blocked=true, messages 原样返回 (由调用方决定拒绝)。
 *   未命中或 monitor 模式时 messages 为原引用 (前缀稳定)。
 */
function redactMessages(messages, opts = {}) {
  const accFindings = [];
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: messages || [], findings: accFindings, blocked: false, changed: false };
  }
  const rules = _rulesFor(opts);
  const scanOpts = { ...opts, _rules: rules };
  const mode = opts.mode || "redact";
  const includeToolCallArgs = opts.includeToolCallArgs !== false;
  const monitorOrBlock = mode === "monitor" || mode === "block";

  let anyChanged = false;
  const output = messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    let msgChanged = false;
    const next = message;
    let contentResult = { content: message.content, changed: false };
    if (message.content !== undefined && message.content !== null) {
      contentResult = _scanContent(message.content, scanOpts, accFindings);
    }
    let toolCalls = message.tool_calls;
    let toolCallsChanged = false;
    if (includeToolCallArgs && Array.isArray(message.tool_calls)) {
      toolCalls = message.tool_calls.map((call) => {
        const args = call && call.function && call.function.arguments;
        if (typeof args !== "string" || !args) return call;
        const result = _scanToolCallArgs(args, scanOpts, accFindings);
        if (result.changed) {
          toolCallsChanged = true;
          return {
            ...call,
            function: { ...call.function, arguments: result.text },
          };
        }
        return call;
      });
    }
    msgChanged = contentResult.changed || toolCallsChanged;
    // block / monitor 模式: 不改写正文, 只收集 findings
    if (monitorOrBlock || !msgChanged) return next;
    anyChanged = true;
    const cloned = { ...message, content: contentResult.content };
    if (toolCallsChanged) cloned.tool_calls = toolCalls;
    return cloned;
  });

  const blocked = mode === "block" && accFindings.length > 0;
  return {
    messages: anyChanged ? output : messages,
    findings: _mergeFindings(accFindings),
    blocked,
    changed: anyChanged,
  };
}

function _mergeFindings(findings) {
  const byName = new Map();
  for (const f of findings) {
    const prev = byName.get(f.name);
    if (prev) prev.count += f.count;
    else byName.set(f.name, { name: f.name, category: f.category, count: f.count });
  }
  return Array.from(byName.values());
}

// 从 provider/route/全局配置解析出 opts (per-route 覆盖全局)。
//   settings 形如: { enabled, mode, enableRules, disableRules, customRules, includeToolCallArgs }
function resolveSettings(globalCfg, routeCfg) {
  const g = (globalCfg && globalCfg.outboundRedact) || {};
  const r = (routeCfg && routeCfg.outboundRedact) || {};
  const merged = { ...g, ...r };
  return {
    enabled: merged.enabled === true,
    mode: merged.mode || "redact",
    enableRules: merged.enableRules,
    disableRules: merged.disableRules,
    customRules: merged.customRules,
    includeToolCallArgs: merged.includeToolCallArgs,
  };
}

module.exports = {
  DEFAULT_RULES,
  scanText,
  redactMessages,
  resolveSettings,
};

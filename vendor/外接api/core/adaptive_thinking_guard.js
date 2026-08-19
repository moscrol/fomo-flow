"use strict";
/**
 * adaptive_thinking_guard.js · Adaptive Thinking 规范化守卫 · 移植自 OmniRoute
 * ═══════════════════════════════════════════════════════════════
 *
 *   道义: 第十六章「致虛極也 守情表也」· 万物旁作吾以观其复
 *         守者, 最终防护层 · 出站前扫一切路径漏入的旧格式
 *
 *   问题: Opus 4.6+/5 · Sonnet 4.6+ 不再接受:
 *           thinking:{type:"enabled", budget_tokens:N}
 *         只认:
 *           thinking:{type:"adaptive"}
 *           output_config:{effort:"low"|"medium"|"high"}
 *
 *   adapters.js 的 _isAdaptiveAnthropicModel 在 buildRequest 时处理,
 *   但透传(passthrough)路径跳过 buildRequest → 旧格式直接出站 → 上游 400。
 *
 *   本模块: 出站前最终守卫 · 不论请求来自哪个路径(buildRequest / 透传 / 手动构造),
 *           扫一遍 body, 如果目标是 adaptive 模型但带了旧格式 → 强制转换。
 *
 *   零依赖 · 纯 Node.js · 与 adapters.js / revproxy.js / dao_router.js 协同
 */

// ── Adaptive 模型判定 (与 adapters.js _isAdaptiveAnthropicModel 同步) ──────

/**
 * 判定模型是否为 adaptive thinking 模型
 * Opus 4.6+ / Sonnet 4.6+ / Claude 5+
 */
function isAdaptiveModel(model) {
  let name = String(model || "").toLowerCase();
  for (const prefix of ["us.anthropic.", "eu.anthropic.", "anthropic."]) {
    if (name.startsWith(prefix)) name = name.slice(prefix.length);
  }
  // 明确非 adaptive: 旧模型
  if (/claude-(?:3|opus-4-[015]|sonnet-4-[05]|haiku-4-5)/.test(name))
    return false;
  // 明确 adaptive: 新模型
  if (/claude-(?:opus|sonnet)-4-(?:6|7|8|9)|claude-(?:opus|sonnet)-5/.test(name))
    return true;
  // 兜底: 其他 claude- 开头的视为 adaptive (API 会自行拒绝旧格式)
  return /^claude-/.test(name);
}

// ── 核心守卫: 规范化出站 body ──────────────────────────────────────

/**
 * 出站前最终守卫: 扫一遍请求 body, 如果目标是 adaptive 模型但带了旧 thinking 格式,
 * 强制转换为 adaptive 格式。
 *
 * 道义: 此为「最终防护层」· 不论哪条路径漏进来的旧格式, 出站前一律扫净。
 *
 * @param {object|string} body - 请求 body (对象或 JSON 字符串)
 * @param {string} model - 目标模型名
 * @returns {{ body: object, converted: boolean, reason: string }}
 */
function guardRequest(body, model) {
  let obj = body;
  let wasString = false;

  // 字符串 body → 解析
  if (typeof body === "string") {
    try {
      obj = JSON.parse(body);
      wasString = true;
    } catch (_) {
      return { body, converted: false, reason: "unparseable body" };
    }
  }

  if (!obj || typeof obj !== "object") {
    return { body, converted: false, reason: "non-object body" };
  }

  // 非 adaptive 模型 → 不处理
  if (!isAdaptiveModel(model)) {
    return { body: wasString ? JSON.stringify(obj) : obj, converted: false, reason: "non-adaptive model" };
  }

  let converted = false;
  const reasons = [];

  // ── 检查 thinking 字段 ──────────────────────────────────────
  if (obj.thinking) {
    const t = obj.thinking;
    const type = String(t.type || "").toLowerCase();

    // 旧格式: thinking:{type:"enabled", budget_tokens:N}
    if (type === "enabled" || (t.budget_tokens != null && type !== "adaptive")) {
      const oldBudget = t.budget_tokens;

      // 提取 effort 信息 (如果有 output_config.effort 则优先用)
      let effort = null;
      if (obj.output_config && obj.output_config.effort) {
        effort = String(obj.output_config.effort).toLowerCase();
      } else if (oldBudget) {
        effort = _effortFromBudget(oldBudget);
      }

      // 转换为 adaptive 格式
      obj.thinking = { type: "adaptive" };
      if (!obj.output_config) obj.output_config = {};
      if (effort) {
        obj.output_config.effort = effort;
      } else if (!obj.output_config.effort) {
        obj.output_config.effort = "medium"; // 默认
      }

      converted = true;
      reasons.push(`thinking.type "${type}" → "adaptive" (budget=${oldBudget} → effort=${effort || "medium"})`);
    }

    // thinking:{type:"enabled"} 无 budget → 也转
    if (type === "enabled" && t.budget_tokens == null) {
      obj.thinking = { type: "adaptive" };
      if (!obj.output_config) obj.output_config = {};
      if (!obj.output_config.effort) obj.output_config.effort = "medium";
      converted = true;
      reasons.push('thinking.type "enabled" (no budget) → "adaptive"');
    }
  }

  // ── 检查遗留的 reasoning_effort (OpenAI 风格泄露到 Anthropic 路径) ──
  if (obj.reasoning_effort && !obj.output_config) {
    obj.output_config = { effort: String(obj.reasoning_effort).toLowerCase() };
    delete obj.reasoning_effort;
    converted = true;
    reasons.push("reasoning_effort → output_config.effort");
  }

  // ── 检查 reasoning 对象 (OpenAI Responses 风格泄露) ──────────
  if (obj.reasoning && typeof obj.reasoning === "object" && obj.reasoning.effort) {
    if (!obj.output_config) obj.output_config = {};
    if (!obj.output_config.effort) {
      obj.output_config.effort = String(obj.reasoning.effort).toLowerCase();
      converted = true;
      reasons.push("reasoning.effort → output_config.effort");
    }
    // adaptive 模型不需要 reasoning 对象
    if (converted) {
      delete obj.reasoning;
    }
  }

  const result = wasString ? JSON.stringify(obj) : obj;
  return {
    body: result,
    converted,
    reason: reasons.length ? reasons.join("; ") : "no conversion needed",
  };
}

// ── 工具函数 ──────────────────────────────────────────────────────

function _effortFromBudget(budgetTokens) {
  const value = Number(budgetTokens) || 0;
  if (value > 0 && value <= 2048) return "low";
  if (value > 0 && value <= 8192) return "medium";
  return "high";
}

/**
 * 检测 body 是否携带了旧 thinking 格式 (诊断用 · 不修改)
 */
function hasLegacyThinking(body, model) {
  if (!isAdaptiveModel(model)) return false;
  if (!body || typeof body !== "object") return false;
  if (body.thinking) {
    const type = String(body.thinking.type || "").toLowerCase();
    if (type === "enabled") return true;
    if (body.thinking.budget_tokens != null && type !== "adaptive") return true;
  }
  return false;
}

// ── 自检 ──────────────────────────────────────────────────────────

function _selfTest() {
  const assert = require("assert");

  // 测试 1: adaptive 模型 + 旧格式 → 转换
  {
    const body = {
      model: "claude-opus-4-6",
      thinking: { type: "enabled", budget_tokens: 16384 },
      messages: [],
    };
    const { body: result, converted, reason } = guardRequest(body, "claude-opus-4-6");
    assert.strictEqual(converted, true, "should convert");
    assert.strictEqual(result.thinking.type, "adaptive", "thinking should be adaptive");
    assert.strictEqual(result.output_config.effort, "high", "16384 budget → high effort");
    console.log("[adaptive_thinking_guard] test 1 PASS: " + reason);
  }

  // 测试 2: adaptive 模型 + 已是 adaptive → 不转换
  {
    const body = {
      model: "claude-sonnet-4-6",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      messages: [],
    };
    const { converted, reason } = guardRequest(body, "claude-sonnet-4-6");
    assert.strictEqual(converted, false, "should not convert");
    console.log("[adaptive_thinking_guard] test 2 PASS: " + reason);
  }

  // 测试 3: 非 adaptive 模型 → 不处理
  {
    const body = {
      model: "claude-sonnet-4",
      thinking: { type: "enabled", budget_tokens: 10000 },
      messages: [],
    };
    const { converted, reason } = guardRequest(body, "claude-sonnet-4");
    assert.strictEqual(converted, false, "should not convert non-adaptive");
    console.log("[adaptive_thinking_guard] test 3 PASS: " + reason);
  }

  // 测试 4: JSON 字符串 body
  {
    const bodyStr = JSON.stringify({
      model: "claude-opus-4-7",
      thinking: { type: "enabled", budget_tokens: 2048 },
    });
    const { body: result, converted } = guardRequest(bodyStr, "claude-opus-4-7");
    assert.strictEqual(converted, true, "should convert string body");
    const parsed = JSON.parse(result);
    assert.strictEqual(parsed.thinking.type, "adaptive", "string body thinking should be adaptive");
    assert.strictEqual(parsed.output_config.effort, "low", "2048 budget → low effort");
    console.log("[adaptive_thinking_guard] test 4 PASS: string body conversion");
  }

  // 测试 5: reasoning_effort 泄露到 Anthropic 路径
  {
    const body = {
      model: "claude-opus-5",
      reasoning_effort: "high",
      messages: [],
    };
    const { body: result, converted } = guardRequest(body, "claude-opus-5");
    assert.strictEqual(converted, true);
    assert.strictEqual(result.output_config.effort, "high");
    assert.strictEqual(result.reasoning_effort, undefined);
    console.log("[adaptive_thinking_guard] test 5 PASS: reasoning_effort leak fixed");
  }

  console.log("[adaptive_thinking_guard] ALL TESTS PASSED");
}

module.exports = {
  isAdaptiveModel,
  guardRequest,
  hasLegacyThinking,
  _effortFromBudget,
  _selfTest,
};

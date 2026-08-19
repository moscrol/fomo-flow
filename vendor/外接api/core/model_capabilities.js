"use strict";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
const BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 65536 };

function _level(value) {
  const raw = String(value == null ? "" : value).trim().toLowerCase().replace(/[\s_-]+/g, "");
  const aliases = {
    none: "off",
    disabled: "off",
    false: "off",
    min: "minimal",
    lowest: "minimal",
    med: "medium",
    normal: "medium",
    default: "medium",
    higher: "high",
    highest: "xhigh",
    extra: "xhigh",
    extrahigh: "xhigh",
    maximum: "max",
    enabled: "auto",
    true: "auto",
    dynamic: "auto",
  };
  const normalized = aliases[raw] || raw;
  return LEVELS.includes(normalized) ? normalized : null;
}

function normalizeLevels(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    if (value && typeof value === "object") {
      const nested = value.name ?? value.id ?? value.value ?? value.level ?? value.effort;
      const normalized = _level(nested);
      if (normalized && !result.includes(normalized)) result.push(normalized);
      continue;
    }
    const normalized = _level(value);
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return LEVELS.filter((level) => result.includes(level));
}

function _collectMetadataLevels(metadata) {
  const found = [];
  const keys = new Set([
    "reasoningefforts",
    "supportedreasoningefforts",
    "reasoningeffort",
    "thinkinglevels",
    "supportedthinkinglevels",
    "thinkinglevel",
    "efforts",
    "effort",
  ]);
  function visit(value, depth) {
    if (depth > 5 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
      if (keys.has(normalizedKey)) found.push(...normalizeLevels(item));
      else visit(item, depth + 1);
    }
  }
  visit(metadata, 0);
  return normalizeLevels(found);
}

function _supportedParameters(metadata) {
  const candidates = [
    metadata && metadata.supported_parameters,
    metadata && metadata.supportedParameters,
    metadata && metadata.capabilities && metadata.capabilities.supported_parameters,
  ];
  return Array.from(
    new Set(
      candidates
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .map((value) => String(value || "").toLowerCase()),
    ),
  );
}

function infer(model, metadata, providerCfg) {
  metadata = metadata && typeof metadata === "object" ? metadata : {};
  providerCfg = providerCfg && typeof providerCfg === "object" ? providerCfg : {};
  const id = String(model || metadata.id || metadata.name || "").replace(/^models\//, "");
  const name = id.toLowerCase();
  const protocol = String(providerCfg.protocol || "").toLowerCase();
  const params = _supportedParameters(metadata);
  let levels = _collectMetadataLevels(metadata);
  let transport = "none";
  let source = levels.length ? "metadata" : "heuristic";

  const explicitThinking = [
    metadata.supportsThinking,
    metadata.supports_thinking,
    metadata.reasoning,
    metadata.capabilities && metadata.capabilities.reasoning,
    metadata.capabilities && metadata.capabilities.supportsThinking,
  ].some((value) => value === true || (value && typeof value === "object"));
  const paramsThinking = params.some((value) => /reasoning|thinking/.test(value));

  if (/^(o1|o3|o4)(?:[-_.]|$)|gpt[-_.]?5/.test(name)) {
    transport = "effort";
    if (!levels.length) levels = /gpt[-_.]?5[-_.]?(?:[2-9]|\d{2,})/.test(name)
      ? ["minimal", "low", "medium", "high", "xhigh"]
      : ["minimal", "low", "medium", "high"];
  } else if (/claude.*(?:3[-_.]?7|4|opus|sonnet)/.test(name)) {
    transport = "budget";
    if (!levels.length) levels = ["off", "low", "medium", "high", "max"];
  } else if (/gemini.*(?:2[-_.]?5|3|thinking)/.test(name)) {
    transport = "budget";
    if (!levels.length) levels = ["off", "low", "medium", "high"];
  } else if (/deepseek.*(?:reasoner|r1|thinking)|(?:^|[-_.])r1(?:[-_.]|$)/.test(name)) {
    transport = "toggle";
    if (!levels.length) levels = ["auto"];
  } else if (/qwen3|qwq|glm.*(?:z1|thinking)|kimi.*thinking|mimo.*thinking/.test(name)) {
    transport = protocol === "openai-responses" ? "effort" : "toggle";
    if (!levels.length) levels = ["off", "low", "medium", "high"];
  } else if (/grok.*mini|magistral/.test(name)) {
    transport = "effort";
    if (!levels.length) levels = ["low", "medium", "high"];
  } else if (explicitThinking || paramsThinking || levels.length) {
    transport = protocol === "anthropic" || protocol === "gemini" ? "budget" : "effort";
    if (!levels.length) levels = ["off", "low", "medium", "high"];
  }

  levels = normalizeLevels(levels);
  if (!levels.length || transport === "none") {
    levels = ["off"];
    transport = "none";
    source = "none";
  }
  const explicitTools = [
    metadata.supportsToolCalls,
    metadata.supports_tool_calls,
    metadata.capabilities && metadata.capabilities.tools,
    metadata.capabilities && metadata.capabilities.supportsToolCalls,
  ].find((value) => typeof value === "boolean");
  const toolsListed = params.length ? params.some((value) => /tools?|function/.test(value)) : null;
  const supportsTools = explicitTools != null ? explicitTools : toolsListed != null ? toolsListed : true;
  const defaultLevel = levels.includes("off") ? "off" : levels.includes("medium") ? "medium" : levels[0];
  return {
    model: id,
    supportsThinking: levels.some((level) => level !== "off"),
    reasoningLevels: levels,
    defaultReasoningLevel: defaultLevel,
    transport,
    source,
    supportsTools,
    supportsParallelTools:
      metadata.supportsParallelToolCalls !== false &&
      metadata.supports_parallel_tool_calls !== false,
    toolRisk: supportsTools ? "compatible" : "unsupported",
  };
}

function settingsFor(level, capability, protocol) {
  capability = capability || { reasoningLevels: ["off"], transport: "none" };
  const levels = normalizeLevels(capability.reasoningLevels || ["off"]);
  let selected = _level(level) || capability.defaultReasoningLevel || levels[0] || "off";
  if (!levels.includes(selected)) selected = levels.includes("off") ? "off" : levels[0];
  const result = {
    reasoningLevel: selected,
    thinkingEnabled: selected !== "off",
    thinkingBudget: null,
    reasoningEffort: null,
  };
  if (selected === "off") return result;
  const transport = capability.transport || "none";
  const normalizedProtocol = String(protocol || "").toLowerCase();
  if (transport === "effort" || normalizedProtocol === "openai-responses") {
    result.reasoningEffort = selected === "auto" || selected === "max" ? "high" : selected;
    result.thinkingEnabled = normalizedProtocol === "openai-responses";
  } else if (transport === "budget" || normalizedProtocol === "anthropic" || normalizedProtocol === "gemini") {
    result.thinkingBudget = BUDGETS[selected] || BUDGETS.medium;
  }
  return result;
}

function catalogEntry(record) {
  const capability = record.capabilities || infer(record.upstreamModel, {}, { protocol: record.protocol });
  return {
    label: record.label || record.id,
    modelUid: record.id,
    creditMultiplier: 0,
    pricingType: "MODEL_PRICING_TYPE_STATIC_CREDIT",
    supportsImages: record.supportsImages === true,
    provider: "MODEL_PROVIDER_CUSTOM",
    isRecommended: false,
    isNew: true,
    maxTokens: Number(record.contextTokens) || 131072,
    modelInfo: {
      modelUid: record.id,
      modelType: "MODEL_TYPE_CHAT",
      maxTokens: Number(record.contextTokens) || 131072,
      tokenizerType: "CL100K_WITH_SPECIAL",
      modelFeatures: {
        zeroShotCapable: true,
        supportsImages: record.supportsImages === true,
        supportsToolCalls: capability.supportsTools !== false,
        supportsParallelToolCalls: capability.supportsParallelTools !== false,
        supportsThinking: capability.supportsThinking === true,
      },
      maxOutputTokens: Number(record.maxOutputTokens) || 16384,
      inferenceServerUrl: "http://127.0.0.1",
      harnessUids: ["strawberry-pancake"],
      modelFamilyUid: record.id,
      displayOption: 0,
    },
    modelCostTier: "MODEL_COST_TIER_FREE",
    modelFamilyMetadata: {
      modelFamilyLabel: record.label || record.id,
      entries: capability.supportsThinking
        ? [{ key: "Reasoning Effort", value: { order: 1, name: record.reasoningLevel || capability.defaultReasoningLevel } }]
        : [],
      isDefaultModelInFamily: true,
    },
    isDefaultModelInFamily: true,
    disabled: false,
    _customModel: true,
    _capabilities: capability,
  };
}

module.exports = { LEVELS, BUDGETS, normalizeLevels, infer, settingsFor, catalogEntry };

"use strict";

const caps = require("./model_capabilities");
let failures = 0;
function ok(name, value) {
  if (value) console.log("  ✓ " + name);
  else { failures++; console.error("  ✗ " + name); }
}

const gpt = caps.infer("gpt-5.4", {}, { protocol: "openai-responses" });
ok("GPT-5 推断命名强度", gpt.reasoningLevels.includes("minimal") && gpt.reasoningLevels.includes("high"));
ok("GPT-5 使用 effort", gpt.transport === "effort");
const claude = caps.infer("claude-sonnet-4-6", {}, { protocol: "anthropic" });
ok("Claude 支持开关与五档", claude.reasoningLevels[0] === "off" && claude.reasoningLevels.includes("max"));
const gemini = caps.infer("gemini-2.5-pro", {}, { protocol: "gemini" });
ok("Gemini 使用 budget", gemini.transport === "budget");
const deepseek = caps.infer("deepseek-reasoner", {}, { protocol: "openai-chat" });
ok("DeepSeek Reasoner 固定自动思考", deepseek.reasoningLevels.length === 1 && deepseek.reasoningLevels[0] === "auto");
const metadata = caps.infer("vendor-model", { supported_reasoning_efforts: ["low", "high"], supported_parameters: ["tools", "reasoning"] }, { protocol: "openai-chat" });
ok("优先读取模型元数据强度", metadata.source === "metadata" && metadata.reasoningLevels.join(",") === "low,high");
ok("元数据识别工具支持", metadata.supportsTools === true);
const settings = caps.settingsFor("high", claude, "anthropic");
ok("Anthropic high 映射预算", settings.thinkingEnabled && settings.thinkingBudget === 16384 && !settings.reasoningEffort);
const responseSettings = caps.settingsFor("low", gpt, "openai-responses");
ok("Responses low 映射 effort", responseSettings.thinkingEnabled && responseSettings.reasoningEffort === "low");
const entry = caps.catalogEntry({ id: "my-model", label: "My Model", upstreamModel: "gpt-5.4", protocol: "openai-responses", capabilities: gpt });
ok("自定义模型目录支持工具", entry.modelInfo.modelFeatures.supportsToolCalls === true);
ok("自定义模型目录支持思考", entry.modelInfo.modelFeatures.supportsThinking === true);

console.log(failures ? `\n${failures} FAIL` : "\nALL PASS");
process.exit(failures ? 1 : 0);

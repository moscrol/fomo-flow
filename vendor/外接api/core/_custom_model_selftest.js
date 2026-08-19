"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dao-custom-model-"));
const configPath = path.join(temp, "config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    gateway: { host: "127.0.0.1", port: 11435 },
    providers: {
      test: {
        enabled: true,
        baseUrl: "http://127.0.0.1:9/v1",
        protocol: "openai-responses",
        models: ["seed-model"],
      },
      backup: {
        enabled: true,
        baseUrl: "http://127.0.0.1:10/v1",
        protocol: "openai-responses",
        models: ["gpt-5.4-backup"],
      },
    },
    customModels: {},
    daoRoutes: {
      enabled: true,
      routes: { seed: { provider: "test", model: "seed-model" } },
    },
  }),
  "utf8",
);
process.env.DAO_BYOK_CONFIG = configPath;

const adapters = require("./adapters");
const runtime = require("../runtime");
let failures = 0;
function ok(name, value) {
  if (value) console.log("  ✓ " + name);
  else { failures++; console.error("  ✗ " + name); }
}

async function main() {
runtime.ensure({ log: () => {} });
const capabilityResult = runtime.hotGetModelCapability("test", "gpt-5.4");
ok("runtime 透传模型能力接口", capabilityResult.ok && capabilityResult.capability.reasoningLevels.includes("high"));
let result = runtime.hotUpsertCustomModel({
  id: "my-gpt",
  label: "My GPT",
  provider: "test",
  upstreamModel: "gpt-5.4",
  reasoningLevel: "high",
  maxOutputTokens: 32768,
});
ok("添加自定义模型", result.ok === true && result.model.id === "my-gpt");
let cfg = runtime.hotGetConfig();
ok("同步渠道模型目录", cfg.providers.test.models.includes("gpt-5.4"));
ok("保存能力目录", cfg.providers.test.modelCapabilities["gpt-5.4"].reasoningLevels.includes("high"));
ok("自动生成 Devin 路由", cfg.daoRoutes.routes["my-gpt"]._customModel === true);
ok("路由映射 reasoning effort", cfg.daoRoutes.routes["my-gpt"].reasoningEffort === "high");
ok("runtime 透传自定义模型列表", runtime.hotListCustomModels().length === 1);
ok("自定义目录项支持工具", runtime.hotCustomModelCatalog()[0].modelInfo.modelFeatures.supportsToolCalls === true);
ok(
  "custom model defaults to strict provider binding",
  result.model.autoFallback === false &&
    cfg.daoRoutes.routes["my-gpt"].autoFallback === false,
);
result = runtime.hotUpsertCustomModel({
  id: "my-gpt",
  label: "My GPT",
  channels: [
    { provider: "test", upstreamModel: "gpt-5.4", protocol: "openai-responses", reasoningLevel: "high" },
    { provider: "backup", upstreamModel: "gpt-5.4-backup", protocol: "openai-chat", reasoningLevel: "low" },
  ],
  reasoningLevel: "high",
  maxOutputTokens: 32768,
});
cfg = runtime.hotGetConfig();
ok(
  "多渠道优先队列持久化到自定义模型",
  result.ok === true &&
    result.model.channels.length === 2 &&
    result.model.channels[1].provider === "backup",
);
ok(
  "多渠道优先队列同步到 Devin 路由",
  cfg.daoRoutes.routes["my-gpt"].autoFallback === true &&
    cfg.daoRoutes.routes["my-gpt"].channelPriority[1].model === "gpt-5.4-backup",
);
ok(
  "每个优先级保留独立协议和思考强度",
  result.model.channels[0].protocol === "openai-responses" &&
    result.model.channels[0].reasoningEffort === "high" &&
    result.model.channels[1].protocol === "openai-chat" &&
    result.model.channels[1].reasoningLevel === "low" &&
    cfg.daoRoutes.routes["my-gpt"].channelPriority[0].sourceProtocol === "openai-responses",
);
result = runtime.hotUpsertCustomModel({
  id: "my-gpt",
  label: "My GPT",
  channels: [
    { provider: "backup", upstreamModel: "gpt-5.4-backup" },
    { provider: "test", upstreamModel: "gpt-5.4" },
  ],
  reasoningLevel: "high",
});
cfg = runtime.hotGetConfig();
ok(
  "拖拽重排后的第一项立即成为主渠道",
  result.ok === true &&
    result.model.provider === "backup" &&
    cfg.daoRoutes.routes["my-gpt"].provider === "backup",
);
const toolDefinitions = [
  { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "multi_edit", description: "Apply edits", parameters: { type: "object", properties: { edits: { type: "array", items: { type: "object", properties: { file: { type: "string" }, patch: { type: "string" } } } } } } } },
  { type: "function", function: { name: "mcp_custom.lookup", description: "MCP tool", parameters: { type: "object", properties: { query: { type: "string" } } } } },
];
const adapterCases = [
  ["Chat", adapters.OpenAIChatAdapter, (body) => body.tools.map((tool) => tool.function.name)],
  ["Responses", adapters.OpenAIResponsesAdapter, (body) => body.tools.map((tool) => tool.name)],
  ["Anthropic", adapters.AnthropicAdapter, (body) => body.tools.map((tool) => tool.name)],
  ["Gemini", adapters.GeminiAdapter, (body) => body.tools[0].functionDeclarations.map((tool) => tool.name)],
];
for (const [label, adapter, namesOf] of adapterCases) {
  const body = adapter.buildRequest({ model: "gpt-5.4", messages: [{ role: "user", content: "test" }], tools: toolDefinitions, toolChoice: "auto", maxOutputTokens: 512, stream: false, reasoningEffort: "high" });
  const names = namesOf(body);
  ok(label + " 保留 Devin/MCP 工具名与数量", names.length === toolDefinitions.length && toolDefinitions.every((tool) => names.includes(tool.function.name)));
}
const deepseekThinking = adapters.OpenAIChatAdapter.buildRequest({ model: "deepseek-reasoner", messages: [], tools: toolDefinitions, toolChoice: "required", stream: false, thinkingEnabled: true });
ok("DeepSeek 思考模式保留工具并规避 tool_choice", deepseekThinking.tools.length === toolDefinitions.length && !Object.prototype.hasOwnProperty.call(deepseekThinking, "tool_choice"));
await new Promise((resolve) => setTimeout(resolve, 100));
const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
ok(
  "持久化 customModels",
  persisted.customModels &&
    persisted.customModels["my-gpt"] &&
    persisted.customModels["my-gpt"].provider === "backup" &&
    persisted.customModels["my-gpt"].channels.length === 2,
);

runtime.hotAddRoute("other-route", { provider: "test", model: "gpt-5.4" });
result = runtime.hotRemoveCustomModel("my-gpt");
ok("被其他路由引用时拒绝删除", result.ok === false && result.references.includes("other-route"));
runtime.hotRemoveRoute("other-route");
result = runtime.hotRemoveCustomModel("my-gpt");
ok("解除引用后删除", result.ok === true);
cfg = runtime.hotGetConfig();
ok("删除自动路由", !cfg.daoRoutes.routes["my-gpt"]);
ok("旧 Devin 会话仍命中隐藏兼容路由", runtime.shouldRoute("my-gpt") === true);
ok("删除手工加入渠道的模型", !cfg.providers.test.models.includes("gpt-5.4"));
ok("删除注册表记录", runtime.hotListCustomModels().length === 0);
const retiredPersisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
ok(
  "隐藏兼容路由持久化并保留原上游",
  retiredPersisted.daoRoutes.routes["my-gpt"]._customModelRetired === true &&
    retiredPersisted.daoRoutes.routes["my-gpt"].model === "gpt-5.4-backup",
);

result = runtime.hotUpsertCustomModel({
  id: "my-gpt",
  provider: "test",
  upstreamModel: "gpt-5.4",
  reasoningLevel: "low",
});
ok("重新添加同 UID 覆盖隐藏兼容路由", result.ok === true);
ok(
  "重建后的路由恢复为活动自定义模型",
  runtime.hotGetConfig().daoRoutes.routes["my-gpt"]._customModelRetired !== true &&
    runtime.hotGetConfig().daoRoutes.routes["MODEL_MY_GPT"]._customModelRetired !== true &&
    runtime.hotGetConfig().daoRoutes.routes["MODEL_MY_GPT"].reasoningLevel === "low",
);
runtime.hotRemoveCustomModel("my-gpt");

result = runtime.hotUpsertCustomModel({
  id: "shared-gpt",
  provider: "test",
  upstreamModel: "seed-model",
  reasoningLevel: "high",
});
ok("复用渠道已有模型可注册", result.ok === true && result.model.manualModel === false);
result = runtime.hotRemoveCustomModel("shared-gpt");
ok("复用已有上游不被无关路由阻止删除", result.ok === true);

console.log(failures ? `\n${failures} FAIL` : "\nALL PASS");
process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

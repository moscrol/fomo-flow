#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "protocol-bridge-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const bridge = require("./protocol_bridge.js");
const revproxy = require("./revproxy.js");
const state = { providers: {}, routes: {}, customModels: {} };
const runtime = {
  hotGetConfig() {
    return { providers: state.providers, customModels: state.customModels, daoRoutes: { routes: state.routes } };
  },
  hotAddProvider(name, cfg) {
    const old = state.providers[name] || {};
    state.providers[name] = Object.assign({}, old, cfg);
    if (!cfg.apiKey && old.apiKey) state.providers[name].apiKey = old.apiKey;
    return { ok: true };
  },
  hotRemoveProvider(name) {
    delete state.providers[name];
    for (const key of Object.keys(state.routes))
      if (state.routes[key].provider === name) delete state.routes[key];
    return { ok: true };
  },
  hotAddRoute(model, route) {
    state.routes[model] = route;
    return { ok: true };
  },
  hotRemoveRoute(model) {
    delete state.routes[model];
    return { ok: true };
  },
};

let failures = 0;
function check(name, value) {
  if (value) console.log("  ✓ " + name);
  else {
    console.error("  ✗ " + name);
    failures++;
  }
}

const created = bridge.upsert(
  {
    name: "DeepSeek Responses",
    providerMode: "managed",
    providerName: "deepseek-relay",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "secret-test-key",
    sourceProtocol: "openai-chat",
    sourceModel: "deepseek-chat",
    outputModel: "deepseek-responses",
    targetProtocols: ["openai-responses", "anthropic"],
    reasoningLevel: "off",
  },
  runtime,
  8919,
);
check("创建档案", created.ok && created.profile.id);
check("同步 provider", state.providers["deepseek-relay"]._bridgeManaged === true);
check(
  "同步 route",
  state.routes["deepseek-responses"].model === "deepseek-chat" &&
    state.routes["deepseek-responses"]._targetProtocols.includes("openai-responses"),
);
const disk = fs.readFileSync(bridge._filePath(), "utf8");
check("档案不重复保存 API Key", !disk.includes("secret-test-key"));
const listed = bridge.list(runtime, 8919);
check(
  "列表返回同步状态与端点",
  listed.profiles[0].sync.provider &&
    listed.profiles[0].sync.route &&
    /\/v1\/responses$/.test(listed.profiles[0].endpoints["openai-responses"]),
);

state.providers.existing = {
  baseUrl: "https://api.xiaomimimo.com/v1",
  protocol: "openai-chat",
  supportedProtocols: ["openai-chat", "anthropic"],
  apiKey: "mimo-key",
  models: ["mimo-v2-flash"],
  modelCapabilities: {
    "mimo-v2-flash": {
      supportsThinking: true,
      reasoningLevels: ["off", "low", "medium", "high"],
      defaultReasoningLevel: "off",
      transport: "budget",
      supportsTools: true,
    },
  },
};
const existing = bridge.upsert(
  {
    name: "MiMo Gemini",
    providerMode: "existing",
    providerName: "existing",
    sourceProtocol: "anthropic",
    sourceModel: "mimo-v2-flash",
    outputModel: "mimo-gemini",
    targetProtocols: ["gemini"],
    reasoningLevel: "high",
  },
  runtime,
  8919,
);
check("复用已有渠道可选择探测协议", existing.ok && existing.profile.sourceProtocol === "anthropic");
check("已有渠道不被改写", state.providers.existing.apiKey === "mimo-key");
check(
  "列表返回渠道协议能力",
  bridge.list(runtime, 8919).providers.find((provider) => provider.name === "existing").protocols.includes("anthropic"),
);
check(
  "列表回显档案所选协议",
  bridge.list(runtime, 8919).profiles.find((profile) => profile.id === existing.profile.id).sourceProtocol === "anthropic",
);
check("同步路由保存上游协议", state.routes["mimo-gemini"].sourceProtocol === "anthropic");
check(
  "中转档位同步到路由",
  existing.profile.reasoningLevel === "high" &&
    state.routes["mimo-gemini"].thinkingEnabled === true &&
    state.routes["mimo-gemini"].thinkingBudget === 16384,
);
const resolved = revproxy.resolveTarget("mimo-gemini", {
  getEaConfig: () => ({ providers: state.providers, daoRoutes: { routes: state.routes } }),
});
check("模型反代使用中转路由协议", resolved && resolved.proto === "anthropic");

state.providers.backup = {
  baseUrl: "https://backup.example/v1",
  protocol: "openai-responses",
  enabled: true,
  models: ["gpt-5.6-sol"],
};
state.customModels = {
  shared: {
    id: "shared",
    label: "Shared GPT",
    provider: "existing",
    upstreamModel: "mimo-v2-flash",
    protocol: "anthropic",
    reasoningLevel: "high",
    capabilities: state.providers.existing.modelCapabilities["mimo-v2-flash"],
    channels: [
      { provider: "existing", upstreamModel: "mimo-v2-flash" },
      { provider: "backup", upstreamModel: "gpt-5.6-sol" },
    ],
  },
};
state.routes.shared = {
  provider: "existing",
  model: "mimo-v2-flash",
  _customModel: true,
  _customModelId: "shared",
  autoFallback: true,
  channelPriority: [
    { provider: "existing", model: "mimo-v2-flash", protocol: "anthropic" },
    { provider: "backup", model: "gpt-5.6-sol", protocol: "openai-responses" },
  ],
};
const originalGetConfig = runtime.hotGetConfig;
runtime.hotGetConfig = function () {
  return { providers: state.providers, customModels: state.customModels || {}, daoRoutes: { routes: state.routes } };
};
const sharedBridge = bridge.upsert(
  {
    name: "Shared multi channel",
    providerMode: "custom",
    sourceRouteUid: "shared",
    sourceModel: "shared",
    outputModel: "shared-bridge",
    targetProtocols: ["openai-responses", "anthropic"],
    reasoningLevel: "high",
  },
  runtime,
  8919,
);
check("协议中转可引用⑦自定义模型", sharedBridge.ok && sharedBridge.profile.sourceRouteUid === "shared");
check("协议中转路由保留动态引用", state.routes["shared-bridge"]._customModelRef === "shared");
const sharedListedProfile = (sharedBridge.profiles || []).find((profile) => profile.id === sharedBridge.profile.id);
check(
  "协议中转列表同步显示⑦全部渠道",
  sharedListedProfile && sharedListedProfile.sourceChannels.length === 2 &&
    sharedListedProfile.sourceChannels[1].provider === "backup",
);
const reverseModels = revproxy.listModels({
  getEaConfig: runtime.hotGetConfig,
  getModelCatalog() { return []; },
  getOfficialFamilies() { return []; },
});
const reverseShared = reverseModels.find((model) => model.id === "shared");
const reverseBridge = reverseModels.find((model) => model.id === "shared-bridge");
check(
  "模型反代目录同步显示⑦全部渠道",
  reverseShared && reverseShared.channelPriority.length === 2 &&
    reverseBridge && reverseBridge.channelPriority.length === 2,
);
const sharedResolved = revproxy.resolveTarget("shared-bridge", {
  getEaConfig: runtime.hotGetConfig,
  resolveRoute(uid) {
    const route = state.routes[uid];
    if (!route) return null;
    if (route._customModelRef) return { route: Object.assign({}, route, state.routes[route._customModelRef], { _customModelRef: route._customModelRef }) };
    return { route };
  },
});
const sharedTargets = revproxy._routeChannelTargets(sharedResolved, {
  getEaConfig: runtime.hotGetConfig,
});
check(
  "模型反代动态展开自定义模型全部渠道",
  sharedTargets.length === 2 && sharedTargets[0].provName === "existing" && sharedTargets[1].provName === "backup",
);

const removed = bridge.remove(created.profile.id, runtime, 8919);
check(
  "删除托管档案同步清理 provider/route",
  removed.ok && !state.providers["deepseek-relay"] && !state.routes["deepseek-responses"],
);

console.log(failures ? `\n${failures} FAIL` : "\nALL PASS");
process.exit(failures ? 1 : 0);

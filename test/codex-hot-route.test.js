"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const codex = require("../vendor/外接api/core/codex_hot_route");

assert.strictEqual(codex.normalizeProtocol("openai-compatible"), "openai-chat");
assert.strictEqual(codex.normalizeProtocol("responses"), "openai-responses");
assert.strictEqual(codex.normalizeProtocol("claude"), "anthropic");
assert.strictEqual(codex.normalizeProtocol("google-generative"), "gemini");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dao-codex-hot-"));
const configPath = path.join(temp, ".codex", "config.toml");
const statePath = path.join(temp, "state", "codex-hot-route.json");
const handoffPath = path.join(temp, "state", "codex-cockpit-handoff.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
const authPath = path.join(temp, ".codex", "auth.json");
const historyPath = path.join(temp, ".codex", "sessions", "thread.jsonl");
fs.mkdirSync(path.dirname(historyPath), { recursive: true });
fs.writeFileSync(authPath, '{"account":"keep-signed-in"}', "utf8");
fs.writeFileSync(historyPath, '{"thread":"keep-history"}\n', "utf8");
const authBefore = fs.readFileSync(authPath);
const historyBefore = fs.readFileSync(historyPath);
const original = [
  'model = "old-model"',
  'model_provider = "old-provider"',
  'model_reasoning_effort = "medium"',
  'approval_policy = "never"',
  '',
  '[projects."E:/keep-me"]',
  'trust_level = "trusted"',
  '',
  '[model_providers.old-provider]',
  'name = "custom"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'base_url = "https://old.invalid/v1"',
  'experimental_bearer_token = "old-provider-secret"',
  '',
].join("\n");
fs.writeFileSync(configPath, original, "utf8");
const originalSnapshot = codex.readCodexConfigSnapshot(configPath);
assert.strictEqual(originalSnapshot.modelProvider, "old-provider");
assert.strictEqual(originalSnapshot.model, "old-model");
assert.strictEqual(originalSnapshot.baseUrl, "https://old.invalid/v1");

let route = null;
let reverseConfig = { enabled: false, apiKey: "local-secret", disabledModels: [codex.LOCAL_MODEL, "other"] };
const overview = {
  providers: {
    kfcoding: { apiKey: "upstream-secret", protocol: "openai-responses", models: ["gpt-5.6-sol"] },
    backup: { apiKey: "backup-secret", protocol: "openai-chat", models: ["deepseek-v3"] },
  },
  daoRoutes: { routes: {} },
};
const runtime = {
  hotGetConfig() {
    return { ...overview, daoRoutes: { routes: {} } };
  },
};
const revproxy = {
  loadConfig() { return { ...reverseConfig, disabledModels: reverseConfig.disabledModels.slice() }; },
  saveConfig(next) { reverseConfig = next; return true; },
};

const first = codex.apply(
  { provider: "kfcoding", model: "gpt-5.6-sol", protocol: "openai-responses", reasoningLevel: "high" },
  runtime,
  revproxy,
  8919,
  { configPath, statePath, handoffPath },
);
assert(first.ok);
assert(first.codex.restartRequired, "first takeover requires one Codex restart");
assert(fs.existsSync(configPath + ".dao-proxy-pro.bak"));
assert.strictEqual(fs.readFileSync(configPath + ".dao-proxy-pro.bak", "utf8"), original);
let text = fs.readFileSync(configPath, "utf8");
assert(text.includes('model = "old-model"'));
assert(text.includes('model_provider = "old-provider"'));
assert(text.includes('model_reasoning_effort = "medium"'));
assert(text.includes('[model_providers.old-provider]'));
assert(text.includes('wire_api = "responses"'));
assert(text.includes('requires_openai_auth = true'));
assert(text.includes('base_url = "http://127.0.0.1:8919/codex-hot/v1"'));
assert(text.includes('experimental_bearer_token = "local-secret"'));
assert(text.includes('approval_policy = "never"'));
assert(text.includes('[projects."E:/keep-me"]'));
assert.strictEqual((text.match(/\[model_providers\.old-provider\]/g) || []).length, 1);
assert.strictEqual(route, null, "Codex hot route must not overwrite module 3 routes");
assert.strictEqual(reverseConfig.enabled, true);
assert(reverseConfig.disabledModels.includes(codex.LOCAL_MODEL), "unrelated reverse-proxy model flags stay untouched");
assert.deepStrictEqual(fs.readFileSync(authPath), authBefore, "account auth cache must remain untouched");
assert.deepStrictEqual(fs.readFileSync(historyPath), historyBefore, "thread history must remain untouched");

const stableConfig = text;
const second = codex.apply(
  { provider: "backup", model: "deepseek-v3", protocol: "openai-chat", reasoningLevel: "low" },
  runtime,
  revproxy,
  8919,
  { configPath, statePath, handoffPath },
);
assert(second.ok);
assert.strictEqual(second.codex.restartRequired, false);
assert.strictEqual(fs.readFileSync(configPath, "utf8"), stableConfig, "hot switch keeps Codex URL/key stable");
assert.strictEqual(route, null);
assert.strictEqual(codex.loadConfig(statePath).provider, "backup");
assert.strictEqual(codex.loadConfig(statePath).model, "deepseek-v3");
assert.strictEqual(codex.loadConfig(statePath).reasoningLevel, "low");

const status = codex.status(8919, runtime.hotGetConfig(), { statePath });
assert(status.codexConfigManaged === true, "isolated status recognizes the managed temp config");
assert.strictEqual(status.codexObserved.modelProvider, "old-provider");
assert.strictEqual(status.codexObserved.model, "old-model");
assert.strictEqual(status.codexObserved.reasoningLevel, "medium");
assert.strictEqual(status.codexObserved.wireApi, "responses");
assert.strictEqual(status.codexObserved.hasProviderToken, true);

const tokenDriftConfig = fs.readFileSync(configPath, "utf8").replace(
  'experimental_bearer_token = "local-secret"',
  'experimental_bearer_token = "unexpected-token"',
);
fs.writeFileSync(configPath, tokenDriftConfig, "utf8");
const tokenDriftStatus = codex.status(8919, runtime.hotGetConfig(), {
  statePath,
  handoffPath,
});
assert.strictEqual(
  tokenDriftStatus.codexConfigManaged,
  false,
  "matching URL with a drifted managed token must not report Codex as managed",
);
fs.writeFileSync(configPath, stableConfig, "utf8");

assert.deepStrictEqual(status.preservation, {
  scope: "config-only",
  authenticationTouched: false,
  historyTouched: false,
  promptContractUntouched: true,
});
// Default tool surface policy for local host-off safety
assert.strictEqual(status.toolSurface, "classic-forced");
assert(status.toolSurfaceHealth && typeof status.toolSurfaceHealth.state === "string");
const serialized = JSON.stringify({ first, second, status });
assert(!serialized.includes("upstream-secret"));
assert(!serialized.includes("backup-secret"));
assert(!serialized.includes("local-secret"));

const acknowledged = codex.markObserved({ at: 123456 }, { statePath });
assert.strictEqual(acknowledged.ok, true);
const cockpitReset = stableConfig
  .replace(
    'base_url = "http://127.0.0.1:8919/codex-hot/v1"',
    'base_url = "https://old.invalid/v1"',
  )
  .replace(
    'experimental_bearer_token = "local-secret"',
    'experimental_bearer_token = "old-provider-secret"',
  );
fs.writeFileSync(configPath, cockpitReset, "utf8");
const repairedReset = codex.reconcileCodexConfig({
  configPath,
  statePath,
  handoffPath,
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "local-secret",
  now: 234567,
});
assert.deepStrictEqual(repairedReset, {
  ok: true,
  state: "repaired",
  changed: true,
  restartRequired: true,
  checkedAt: 234567,
  repairedAt: 234567,
});
assert.strictEqual(fs.readFileSync(configPath, "utf8"), stableConfig);
assert.strictEqual(codex.loadConfig(statePath).restartRequired, true);
assert.strictEqual(codex.loadConfig(statePath).lastObservedAt, 0);

const managedAgain = codex.reconcileCodexConfig({
  configPath,
  statePath,
  handoffPath,
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "local-secret",
  now: 234568,
});
assert.deepStrictEqual(managedAgain, {
  ok: true,
  state: "managed",
  changed: false,
  restartRequired: true,
  checkedAt: 234568,
  repairedAt: 234567,
});

const mixedKnownReset = stableConfig.replace(
  'base_url = "http://127.0.0.1:8919/codex-hot/v1"',
  'base_url = "https://old.invalid/v1"',
);
fs.writeFileSync(configPath, mixedKnownReset, "utf8");
const repairedMixed = codex.reconcileCodexConfig({
  configPath,
  statePath,
  handoffPath,
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "local-secret",
  now: 234569,
});
assert.strictEqual(repairedMixed.ok, true);
assert.strictEqual(repairedMixed.state, "repaired");
assert.strictEqual(fs.readFileSync(configPath, "utf8"), stableConfig);

const unknownDrift = stableConfig.replace(
  'base_url = "http://127.0.0.1:8919/codex-hot/v1"',
  'base_url = "http://127.0.0.1:9999/unknown"',
);
fs.writeFileSync(configPath, unknownDrift, "utf8");
const refusedUnknown = codex.reconcileCodexConfig({
  configPath,
  statePath,
  handoffPath,
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "local-secret",
  now: 234570,
});
assert.deepStrictEqual(refusedUnknown, {
  ok: false,
  state: "drift",
  changed: false,
  restartRequired: true,
  checkedAt: 234570,
  repairedAt: 234569,
  reason: "unknown-managed-values",
});
assert.strictEqual(fs.readFileSync(configPath, "utf8"), unknownDrift);
assert(!JSON.stringify(refusedUnknown).includes("old-provider-secret"));
assert(!JSON.stringify(refusedUnknown).includes("local-secret"));

const providerDrift = stableConfig
  .replace('model_provider = "old-provider"', 'model_provider = "external"') +
  '\n[model_providers.external]\nwire_api = "responses"\nbase_url = "https://external.invalid/v1"\nexperimental_bearer_token = "external-secret"\n';
fs.writeFileSync(configPath, providerDrift, "utf8");
const refusedProvider = codex.reconcileCodexConfig({
  configPath,
  statePath,
  handoffPath,
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "local-secret",
});
assert.strictEqual(refusedProvider.ok, false);
assert.strictEqual(refusedProvider.reason, "provider-changed");
assert.strictEqual(fs.readFileSync(configPath, "utf8"), providerDrift);

const malformedConfig = 'model_provider = "old-provider"\n[broken';
fs.writeFileSync(configPath, malformedConfig, "utf8");
const refusedMalformed = codex.reconcileCodexConfig({
  configPath,
  statePath,
  handoffPath,
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "local-secret",
});
assert.strictEqual(refusedMalformed.ok, false);
assert.strictEqual(refusedMalformed.reason, "config-unreadable");
assert.strictEqual(fs.readFileSync(configPath, "utf8"), malformedConfig);

fs.writeFileSync(configPath, cockpitReset, "utf8");
const missingHandoff = codex.reconcileCodexConfig({
  configPath,
  statePath,
  handoffPath: path.join(temp, "state", "missing-handoff.json"),
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "local-secret",
});
assert.strictEqual(missingHandoff.ok, false);
assert.strictEqual(missingHandoff.reason, "handoff-missing");
assert.strictEqual(fs.readFileSync(configPath, "utf8"), cockpitReset);

const enabledGuardState = codex.loadConfig(statePath);
assert(codex.saveConfig({
  ...enabledGuardState,
  enabled: false,
  configGuardState: "managed",
  lastObservedAt: 987654,
}, statePath));
const migratedDisabledState = codex.loadConfig(statePath);
assert.strictEqual(migratedDisabledState.enabled, false);
assert.strictEqual(migratedDisabledState.configGuardState, "disabled");
assert.strictEqual(migratedDisabledState.lastObservedAt, 0);
const disabledGuard = codex.reconcileCodexConfig({
  configPath,
  statePath,
  handoffPath,
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "local-secret",
});
assert.strictEqual(disabledGuard.ok, true);
assert.strictEqual(disabledGuard.state, "disabled");
assert.strictEqual(fs.readFileSync(configPath, "utf8"), cockpitReset);
assert(codex.saveConfig({ ...enabledGuardState, enabled: true }, statePath));
fs.writeFileSync(configPath, stableConfig, "utf8");

const externallyChanged = stableConfig
  .replace('model_provider = "old-provider"', 'model_provider = "external"')
  .replace('model = "old-model"', 'model = "external-model"') +
  '\n[model_providers.external]\nwire_api = "responses"\nbase_url = "https://external.invalid/v1"\nexperimental_bearer_token = "never-return-this"\n';
fs.writeFileSync(configPath, externallyChanged, "utf8");
const externalStatus = codex.status(8919, runtime.hotGetConfig(), { statePath });
assert.strictEqual(externalStatus.codexConfigManaged, false);
assert.strictEqual(externalStatus.codexObserved.modelProvider, "external");
assert.strictEqual(externalStatus.codexObserved.model, "external-model");
assert.strictEqual(externalStatus.codexObserved.baseUrl, "https://external.invalid/v1");
assert(!JSON.stringify(externalStatus).includes("never-return-this"));
assert.deepStrictEqual(fs.readFileSync(authPath), authBefore);
assert.deepStrictEqual(fs.readFileSync(historyPath), historyBefore);

const legacyConfigPath = path.join(temp, ".codex", "legacy-config.toml");
const legacyBackupPath = legacyConfigPath + ".dao-proxy-pro.bak";
fs.writeFileSync(legacyBackupPath, original, "utf8");
fs.writeFileSync(
  legacyConfigPath,
  original
    .replace('model = "old-model"', 'model = "dao-codex-hot"')
    .replace('model_provider = "old-provider"', 'model_provider = "dao_proxy_hot"')
    .replace('model_reasoning_effort = "medium"', 'model_reasoning_effort = "high"') +
    '\n[model_providers.dao_proxy_hot]\nwire_api = "responses"\nbase_url = "http://127.0.0.1:8919/v1"\nexperimental_bearer_token = "legacy-local"\n',
  "utf8",
);
const migrated = codex.patchCodexConfig({
  configPath: legacyConfigPath,
  handoffPath: path.join(temp, "state", "legacy-handoff.json"),
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "local-secret",
});
assert.strictEqual(migrated.migratedLegacyTakeover, true);
assert.strictEqual(migrated.restartRequired, true);
const migratedText = fs.readFileSync(legacyConfigPath, "utf8");
assert(migratedText.includes('model_provider = "old-provider"'));
assert(migratedText.includes('model = "old-model"'));
assert(migratedText.includes('model_reasoning_effort = "medium"'));
const migratedSnapshot = codex.readCodexConfigSnapshot(legacyConfigPath);
assert.strictEqual(migratedSnapshot.baseUrl, "http://127.0.0.1:8919/codex-hot/v1");
assert.strictEqual(migratedSnapshot.modelProvider, "old-provider");
assert.strictEqual(migratedSnapshot.model, "old-model");

const restoreConfigPath = path.join(temp, ".codex", "restore-config.toml");
const restoreHandoffPath = path.join(temp, "state", "restore-handoff.json");
fs.writeFileSync(restoreConfigPath, original, "utf8");
const activated = codex.patchCodexConfig({
  configPath: restoreConfigPath,
  handoffPath: restoreHandoffPath,
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "dao-loopback-secret",
});
assert.strictEqual(activated.ok, true);
assert.strictEqual(fs.statSync(restoreHandoffPath).mode & 0o777, 0o600);
const restored = codex.restoreCodexConfig({
  configPath: restoreConfigPath,
  handoffPath: restoreHandoffPath,
});
assert.deepStrictEqual(restored, {
  ok: true,
  changed: true,
  restartRequired: true,
  providerName: "old-provider",
});
assert.strictEqual(
  codex.readCodexConfigSnapshot(restoreConfigPath).baseUrl,
  "https://old.invalid/v1",
);
assert(
  fs.readFileSync(restoreConfigPath, "utf8")
    .includes('experimental_bearer_token = "old-provider-secret"'),
);

codex.patchCodexConfig({
  configPath: restoreConfigPath,
  handoffPath: restoreHandoffPath,
  baseUrl: "http://127.0.0.1:8919/codex-hot/v1",
  apiKey: "dao-loopback-secret",
});
fs.writeFileSync(
  restoreConfigPath,
  fs.readFileSync(restoreConfigPath, "utf8").replace(
    'base_url = "http://127.0.0.1:8919/codex-hot/v1"',
    'base_url = "http://127.0.0.1:9999/changed"',
  ),
  "utf8",
);
const refused = codex.restoreCodexConfig({
  configPath: restoreConfigPath,
  handoffPath: restoreHandoffPath,
});
assert.strictEqual(refused.ok, false);
assert.strictEqual(refused.reason, "config-drift");
assert(!JSON.stringify(refused).includes("old-provider-secret"));

let importedConfig = null;
const importingRuntime = {
  hotGetConfig() {
    return importedConfig || { providers: {}, daoRoutes: { routes: {} } };
  },
  hotSetConfig(value) {
    importedConfig = {
      providers: {
        ...((importedConfig && importedConfig.providers) || {}),
        ...(value.providers || {}),
      },
      daoRoutes: { routes: {} },
    };
    return { ok: true };
  },
};
const imported = codex.ensureCockpitProvider(importingRuntime, {
  providerName: "codex_local_access",
  model: "gpt-5.6-sol",
  baseUrl: "http://127.0.0.1:57244/v1",
  bearerToken: "cockpit-private-token",
  wireApi: "responses",
});
assert.strictEqual(imported.name, "cockpit-codex");
assert.strictEqual(
  importedConfig.providers["cockpit-codex"].baseUrl,
  "http://127.0.0.1:57244/v1",
);
assert.strictEqual(
  importedConfig.providers["cockpit-codex"].protocol,
  "openai-responses",
);
assert.deepStrictEqual(
  importedConfig.providers["cockpit-codex"].models,
  ["gpt-5.6-sol"],
);
assert(!JSON.stringify(imported).includes("cockpit-private-token"));

const importConfigPath = path.join(temp, ".codex", "import-config.toml");
const importStatePath = path.join(temp, "state", "import-state.json");
const importHandoffPath = path.join(temp, "state", "import-handoff.json");
fs.writeFileSync(
  importConfigPath,
  original
    .replace('model = "old-model"', 'model = "gpt-5.6-sol"')
    .replace('base_url = "https://old.invalid/v1"', 'base_url = "http://127.0.0.1:57244/v1"')
    .replace('experimental_bearer_token = "old-provider-secret"', 'experimental_bearer_token = "cockpit-private-token"'),
  "utf8",
);
let importReverseConfig = { enabled: false, apiKey: "dao-import-key", disabledModels: [] };
const importRevproxy = {
  loadConfig() { return { ...importReverseConfig, disabledModels: [] }; },
  saveConfig(next) { importReverseConfig = next; return true; },
};
const appliedImport = codex.apply(
  {
    importCurrentProvider: true,
    provider: "cockpit-codex",
    model: "gpt-5.6-sol",
    protocol: "openai-responses",
    reasoningLevel: "high",
  },
  importingRuntime,
  importRevproxy,
  8919,
  {
    configPath: importConfigPath,
    statePath: importStatePath,
    handoffPath: importHandoffPath,
  },
);
assert.strictEqual(appliedImport.ok, true);
assert.strictEqual(appliedImport.config.provider, "cockpit-codex");
assert.strictEqual(appliedImport.config.upstreamImported, true);
assert(!JSON.stringify(appliedImport).includes("cockpit-private-token"));
const observed = codex.markObserved({ at: 123456 }, { statePath: importStatePath });
assert.deepStrictEqual(observed, {
  ok: true,
  lastObservedAt: 123456,
  restartRequired: false,
});
assert.strictEqual(codex.loadConfig(importStatePath).restartRequired, false);
const repeatedImport = codex.apply(
  {
    importCurrentProvider: true,
    provider: "cockpit-codex",
    model: "gpt-5.6-sol",
    protocol: "openai-responses",
    reasoningLevel: "high",
  },
  importingRuntime,
  importRevproxy,
  8919,
  {
    configPath: importConfigPath,
    statePath: importStatePath,
    handoffPath: importHandoffPath,
  },
);
assert.strictEqual(repeatedImport.ok, true);
assert.strictEqual(
  importedConfig.providers["cockpit-codex"].baseUrl,
  "http://127.0.0.1:57244/v1",
  "reapplying a managed route must not import Dao itself as the Cockpit upstream",
);

const disabled = codex.disable({
  configPath: importConfigPath,
  statePath: importStatePath,
  handoffPath: importHandoffPath,
});
assert.strictEqual(disabled.ok, true);
assert.strictEqual(disabled.restartRequired, true);
assert.strictEqual(codex.loadConfig(importStatePath).enabled, false);
const disabledStatus = codex.status(
  8919,
  importingRuntime.hotGetConfig(),
  { statePath: importStatePath, handoffPath: importHandoffPath },
);
assert.strictEqual(disabledStatus.codexConfigManaged, false);
assert.strictEqual(disabledStatus.configGuardState, "disabled");
assert.strictEqual(disabledStatus.lastObservedAt, 0);
assert.strictEqual(
  codex.readCodexConfigSnapshot(importConfigPath).baseUrl,
  "http://127.0.0.1:57244/v1",
);

fs.rmSync(temp, { recursive: true, force: true });
console.log("codex hot route selftest: PASS");

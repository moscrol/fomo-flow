"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { stateFile } = require("../../../core/product_identity.js");
const crypto = require("crypto");
const modelCapabilities = require("./model_capabilities");

const PROTOCOLS = ["openai-chat", "openai-responses", "anthropic", "gemini"];

function _filePath() {
  return (
    stateFile("protocol-bridges.json") ||
    path.join(os.homedir(), ".fomo-flow", "protocol-bridges.json")
  );
}

function _read() {
  try {
    const raw = JSON.parse(fs.readFileSync(_filePath(), "utf8"));
    return Array.isArray(raw.profiles) ? raw.profiles : [];
  } catch {
    return [];
  }
}

function _write(profiles) {
  const file = _filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(
    tmp,
    JSON.stringify({ version: 1, profiles, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
  fs.renameSync(tmp, file);
}

function _slug(value, fallback) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

function _id() {
  return "pb-" + crypto.randomBytes(6).toString("hex");
}

function _protocols(values) {
  return Array.from(new Set((values || []).filter((value) => PROTOCOLS.includes(value))));
}

function _endpointMap(port, model, protocols) {
  const root = "http://127.0.0.1:" + (port || 0);
  const result = {};
  for (const protocol of protocols || []) {
    if (protocol === "openai-chat") result[protocol] = root + "/v1/chat/completions";
    else if (protocol === "openai-responses") result[protocol] = root + "/v1/responses";
    else if (protocol === "anthropic") result[protocol] = root + "/v1/messages";
    else if (protocol === "gemini")
      result[protocol] =
        root + "/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
  }
  return result;
}

function _runtimeConfig(runtime) {
  return runtime && runtime.hotGetConfig ? runtime.hotGetConfig() : { providers: {}, daoRoutes: { routes: {} } };
}

function _safeProviders(runtime) {
  const providers = _runtimeConfig(runtime).providers || {};
  const result = [];
  for (const [name, cfg] of Object.entries(providers)) {
    result.push({
      name,
      baseUrl: cfg.baseUrl || "",
      protocol: cfg.protocol || "",
      protocols: Array.from(
        new Set(
          (Array.isArray(cfg.supportedProtocols) ? cfg.supportedProtocols : [])
            .concat(cfg.protocol || [])
            .filter((value) => PROTOCOLS.includes(value)),
        ),
      ),
      models: Array.isArray(cfg.models) ? cfg.models : [],
      modelCapabilities: cfg.modelCapabilities || {},
      managed: cfg._bridgeManaged === true,
      bridgeId: cfg._bridgeId || "",
      hasKey: !!cfg.apiKey,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function _safeCustomModels(runtime) {
  const cfg = _runtimeConfig(runtime);
  return Object.values(cfg.customModels || {})
    .filter((record) => record && record.id)
    .map((record) => ({
      id: record.id,
      label: record.label || record.id,
      channels: Array.isArray(record.channels) ? record.channels : [],
      protocol: record.protocol || "",
      reasoningLevel: record.reasoningLevel || "off",
      capabilities: record.capabilities || null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function list(runtime, port) {
  const cfg = _runtimeConfig(runtime);
  const providers = cfg.providers || {};
  const routes = (cfg.daoRoutes && cfg.daoRoutes.routes) || {};
  const profiles = _read().map((profile) => {
    const provider = providers[profile.providerName] || {};
    const route = routes[profile.outputModel] || null;
    const sourceRoute = profile.sourceRouteUid ? routes[profile.sourceRouteUid] : null;
    const sourceRecord = profile.sourceRouteUid
      ? (cfg.customModels || {})[profile.sourceRouteUid]
      : null;
    const targetProtocols = _protocols(profile.targetProtocols);
    return Object.assign({}, profile, {
      sourceBaseUrl: provider.baseUrl || "",
      sourceProtocol: profile.sourceProtocol || provider.protocol,
      hasKey: !!provider.apiKey,
      sourceChannels: sourceRecord && Array.isArray(sourceRecord.channels)
        ? sourceRecord.channels.map((channel) => ({
            provider: channel.provider,
            model: channel.upstreamModel || channel.model,
            protocol: channel.protocol || "",
            reasoningLevel: channel.reasoningLevel || "off",
          }))
        : [],
      channelStrategy: sourceRecord && sourceRecord.channelStrategy || "priority",
      capabilities:
        (sourceRecord && sourceRecord.capabilities) ||
        (provider.modelCapabilities && provider.modelCapabilities[profile.sourceModel]) ||
        modelCapabilities.infer(profile.sourceModel, {}, provider),
      endpoints: _endpointMap(port, profile.outputModel, targetProtocols),
      sync: {
        provider: profile.sourceRouteUid ? !!sourceRecord : !!providers[profile.providerName],
        route:
          !!route &&
          (profile.sourceRouteUid
            ? route._customModelRef === profile.sourceRouteUid && !!sourceRoute
            : route.provider === profile.providerName && route.model === profile.sourceModel),
      },
    });
  });
  return { ok: true, protocols: PROTOCOLS, profiles, providers: _safeProviders(runtime), customModels: _safeCustomModels(runtime) };
}

function upsert(input, runtime, port) {
  if (!runtime || !runtime.hotAddProvider || !runtime.hotAddRoute)
    return { ok: false, error: "runtime not loaded" };
  const profiles = _read();
  const id = String(input.id || _id());
  const oldIndex = profiles.findIndex((profile) => profile.id === id);
  const old = oldIndex >= 0 ? profiles[oldIndex] : null;
  const name = String(input.name || "").trim();
  const sourceModel = String(input.sourceModel || "").trim();
  let sourceProtocol = PROTOCOLS.includes(input.sourceProtocol)
    ? input.sourceProtocol
    : "openai-chat";
  const targetProtocols = _protocols(input.targetProtocols);
  const providerMode = ["existing", "custom"].includes(input.providerMode)
    ? input.providerMode
    : "managed";
  const sourceRouteUid = providerMode === "custom"
    ? String(input.sourceRouteUid || input.sourceModel || "").trim()
    : "";
  const outputModel = _slug(input.outputModel || name, "relay-model");
  const providerName =
    providerMode === "existing"
      ? String(input.providerName || "").trim()
      : _slug(input.providerName || "relay-" + name, "relay-" + id.slice(-6));
  if (!name) return { ok: false, error: "name required" };
  if (!providerName && !sourceRouteUid) return { ok: false, error: "provider required" };
  if (!sourceModel && !sourceRouteUid) return { ok: false, error: "sourceModel required" };
  if (!targetProtocols.length) return { ok: false, error: "targetProtocols required" };
  if (sourceRouteUid && outputModel === sourceRouteUid)
    return { ok: false, error: "outputModel must differ from the referenced custom model uid" };
  const cfg = _runtimeConfig(runtime);
  const providers = cfg.providers || {};
  const routes = (cfg.daoRoutes && cfg.daoRoutes.routes) || {};
  const customModels = cfg.customModels || {};
  const sourceCustom = sourceRouteUid ? customModels[sourceRouteUid] : null;
  const sourceRoute = sourceRouteUid ? routes[sourceRouteUid] : null;
  if (sourceRouteUid && (!sourceCustom || !sourceRoute))
    return { ok: false, error: `custom model "${sourceRouteUid}" not found` };
  if (providerMode === "existing" && !providers[providerName])
    return { ok: false, error: `provider "${providerName}" not found` };
  if (providerMode === "existing") {
    const providerProtocols = Array.from(
      new Set(
        (Array.isArray(providers[providerName].supportedProtocols)
          ? providers[providerName].supportedProtocols
          : []
        )
          .concat(providers[providerName].protocol || [])
          .filter((value) => PROTOCOLS.includes(value)),
      ),
    );
    if (!providerProtocols.includes(sourceProtocol) && providerProtocols.length)
      sourceProtocol = providerProtocols[0];
  }
  if (providerMode === "managed" && !String(input.baseUrl || "").trim())
    return { ok: false, error: "baseUrl required" };
  if (
    providerMode === "managed" &&
    providers[providerName] &&
    providers[providerName]._bridgeId !== id
  )
    return { ok: false, error: `provider "${providerName}" already exists` };
  if (routes[outputModel] && routes[outputModel]._bridgeId !== id)
    return { ok: false, error: `model alias "${outputModel}" already routed` };

  const effectiveProviderName = sourceRouteUid ? sourceRoute.provider : providerName;
  const effectiveSourceModel = sourceRouteUid ? sourceRoute.model : sourceModel;
  const sourceProvider = providers[effectiveProviderName] || {
    protocol: sourceProtocol,
    modelCapabilities: {},
  };
  const capability =
    (sourceCustom && sourceCustom.capabilities) ||
    (sourceProvider.modelCapabilities && sourceProvider.modelCapabilities[effectiveSourceModel]) ||
    modelCapabilities.infer(effectiveSourceModel, {}, sourceProvider);
  if (sourceRouteUid) sourceProtocol = sourceRoute.sourceProtocol || sourceRoute.protocol || sourceCustom.protocol || sourceProtocol;
  const reasoning = modelCapabilities.settingsFor(
    input.reasoningLevel || capability.defaultReasoningLevel,
    capability,
    sourceProtocol,
  );

  if (providerMode === "managed") {
    const providerResult = runtime.hotAddProvider(providerName, {
      baseUrl: String(input.baseUrl || "").trim(),
      apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
      protocol: sourceProtocol,
      completionPath: String(input.completionPath || ""),
      models: [sourceModel],
      modelCapabilities: { [sourceModel]: capability },
      enabled: true,
      _bridgeManaged: true,
      _bridgeId: id,
      _bridgeLabel: name,
    });
    if (!providerResult || providerResult.ok !== true) return providerResult;
  }

  const routeResult = runtime.hotAddRoute(outputModel, Object.assign({
    provider: effectiveProviderName,
    model: effectiveSourceModel,
    sourceProtocol,
    maxOutputTokens: Number(input.maxOutputTokens) || 16384,
    _label: `${name} · ${sourceProtocol} → ${targetProtocols.join("+")}`,
    _bridgeManaged: true,
    _bridgeId: id,
    _bridgeOutputModel: outputModel,
    _targetProtocols: targetProtocols,
    _customModelRef: sourceRouteUid || undefined,
    capabilities: capability,
  }, reasoning));
  if (!routeResult || routeResult.ok !== true) {
    if (providerMode === "managed" && !old) runtime.hotRemoveProvider(providerName);
    return routeResult;
  }

  if (old && old.outputModel !== outputModel && runtime.hotRemoveRoute)
    runtime.hotRemoveRoute(old.outputModel);
  if (
    old &&
    old.providerMode === "managed" &&
    old.providerName !== providerName &&
    runtime.hotRemoveProvider
  )
    runtime.hotRemoveProvider(old.providerName);

  const profile = {
    id,
    name,
    providerMode,
    providerName: effectiveProviderName,
    sourceProtocol,
    sourceModel: effectiveSourceModel,
    sourceRouteUid: sourceRouteUid || undefined,
    outputModel,
    targetProtocols,
    maxOutputTokens: Number(input.maxOutputTokens) || 16384,
    reasoningLevel: reasoning.reasoningLevel,
    capabilities: capability,
    createdAt: old?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (oldIndex >= 0) profiles[oldIndex] = profile;
  else profiles.push(profile);
  _write(profiles);
  return Object.assign({ ok: true }, list(runtime, port), { profile });
}

function remove(id, runtime, port) {
  const profiles = _read();
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index < 0) return { ok: false, error: "profile not found" };
  const profile = profiles[index];
  if (profile.providerMode === "managed" && runtime?.hotRemoveProvider)
    runtime.hotRemoveProvider(profile.providerName);
  else if (runtime?.hotRemoveRoute) runtime.hotRemoveRoute(profile.outputModel);
  profiles.splice(index, 1);
  _write(profiles);
  return Object.assign({ ok: true, deleted: id }, list(runtime, port));
}

module.exports = { PROTOCOLS, list, upsert, remove, _filePath };

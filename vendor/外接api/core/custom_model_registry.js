"use strict";

function createForwardingProxy(getTarget) {
  return new Proxy(
    {},
    {
      get(_target, key) {
        return getTarget()[key];
      },
      set(_target, key, value) {
        getTarget()[key] = value;
        return true;
      },
      deleteProperty(_target, key) {
        return delete getTarget()[key];
      },
      ownKeys() {
        return Reflect.ownKeys(getTarget());
      },
      has(_target, key) {
        return key in getTarget();
      },
      getOwnPropertyDescriptor(_target, key) {
        const descriptor = Object.getOwnPropertyDescriptor(getTarget(), key);
        return descriptor
          ? { ...descriptor, configurable: true }
          : undefined;
      },
    },
  );
}

function createCustomModelRegistry(deps) {
  const _customModels = createForwardingProxy(deps.getCustomModels);
  const _providers = createForwardingProxy(deps.getProviders);
  const _routes = createForwardingProxy(deps.getRoutes);
  const _customModelRuntime = deps.customModelRuntime;
  const _conversationProviderAffinity = deps.conversationProviderAffinity;
  const _modelCapabilities = deps.modelCapabilities;
  const hotAddRoute = deps.hotAddRoute;
  const _hotSaveConfig = deps.saveConfig;

function capabilityFor(model, metadata, providerCfg) {
  const capability = _modelCapabilities.infer(model, metadata, providerCfg);
  const contextTokens = Number(
    typeof deps.pickContextLength === "function" ? deps.pickContextLength(model) : 0,
  );
  return contextTokens > 0 ? { ...capability, contextTokens } : capability;
}

function hotListCustomModels() {
  return Object.values(_customModels)
    .filter((record) => record && typeof record === "object")
    .map((record) => ({
      ...record,
      runtime: _customModelRuntime.get(record.id) || null,
    }))
    .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
}

function hotGetModelCapability(provider, model) {
  if (!_modelCapabilities) return { ok: false, error: "model capabilities unavailable" };
  const providerCfg = _providers[String(provider || "")] || null;
  if (!providerCfg) return { ok: false, error: "provider not found" };
  const id = String(model || "").trim();
  if (!id) return { ok: false, error: "model required" };
  const metadata =
    (providerCfg.modelCapabilities && providerCfg.modelCapabilities[id]) || {};
  const capability = capabilityFor(id, metadata, providerCfg);
  providerCfg.modelCapabilities = Object.assign({}, providerCfg.modelCapabilities || {}, {
    [id]: capability,
  });
  _hotSaveConfig();
  return { ok: true, capability };
}

function hotUpsertCustomModel(input) {
  if (!_modelCapabilities) return { ok: false, error: "model capabilities unavailable" };
  input = input && typeof input === "object" ? input : {};
  const id = String(input.id || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const requestedChannels = Array.isArray(input.channels) ? input.channels : [];
  const channels = [];
  const channelKeys = new Set();
  const addChannel = (entry) => {
    const provider = String((entry && entry.provider) || "").trim();
    const upstreamModel = String(
      (entry && (entry.upstreamModel || entry.model)) || "",
    ).trim();
    if (!provider || !upstreamModel) return;
    const key = `${provider}|${upstreamModel}`;
    if (channelKeys.has(key)) return;
    channelKeys.add(key);
    channels.push({
      provider,
      upstreamModel,
      protocol: String((entry && entry.protocol) || "").trim(),
      reasoningLevel: String((entry && entry.reasoningLevel) || "").trim(),
      reasoningEffort: entry && entry.reasoningEffort,
      thinkingEnabled: entry && typeof entry.thinkingEnabled === "boolean" ? entry.thinkingEnabled : undefined,
      thinkingBudget: entry && entry.thinkingBudget != null ? Number(entry.thinkingBudget) || null : undefined,
    });
  };
  requestedChannels.forEach(addChannel);
  if (!channels.length) {
    addChannel({
      provider: input.provider,
      upstreamModel: input.upstreamModel || input.model,
    });
  }
  const primaryChannel = channels[0] || {};
  const provider = primaryChannel.provider || "";
  const upstreamModel = primaryChannel.upstreamModel || "";
  if (!id) return { ok: false, error: "id required" };
  if (!channels.length) return { ok: false, error: "at least one channel is required" };
  if (channels.length > 16) return { ok: false, error: "at most 16 channels are supported" };
  for (const channel of channels) {
    if (!_providers[channel.provider])
      return { ok: false, error: `provider not found: ${channel.provider}` };
  }
  const modelKey = "MODEL_" + id.replace(/-/g, "_").toUpperCase();
  const existingRoute = _routes[id] || _routes[modelKey];
  if (existingRoute && existingRoute._customModelId !== id)
    return { ok: false, error: `model uid "${id}" already routed` };

  const providerCfg = _providers[provider];
  const rawCapability =
    (providerCfg.modelCapabilities && providerCfg.modelCapabilities[upstreamModel]) || {};
  const capability = capabilityFor(upstreamModel, rawCapability, providerCfg);
  const settings = _modelCapabilities.settingsFor(
    input.reasoningLevel || primaryChannel.reasoningLevel || capability.defaultReasoningLevel,
    capability,
    input.protocol || primaryChannel.protocol || providerCfg.protocol,
  );
  const old = _customModels[id] || null;
  const storedChannels = channels.map((channel) => {
    const channelProvider = _providers[channel.provider];
    const wasPresent =
      Array.isArray(channelProvider.models) &&
      channelProvider.models.includes(channel.upstreamModel);
    const raw =
      (channelProvider.modelCapabilities &&
        channelProvider.modelCapabilities[channel.upstreamModel]) ||
      {};
    const channelCapability = capabilityFor(
      channel.upstreamModel,
      raw,
      channelProvider,
    );
    channelProvider.models = Array.from(
      new Set((channelProvider.models || []).concat(channel.upstreamModel)),
    ).sort();
    channelProvider.modelCapabilities = Object.assign(
      {},
      channelProvider.modelCapabilities || {},
      { [channel.upstreamModel]: channelCapability },
    );
    const oldChannels = old
      ? Array.isArray(old.channels)
        ? old.channels
        : [old]
      : [];
    const oldChannel = oldChannels.find(
      (entry) =>
        entry.provider === channel.provider &&
        (entry.upstreamModel || entry.model) === channel.upstreamModel,
    );
    const channelProtocol = channel.protocol || channelProvider.protocol || "openai-chat";
    const channelSettings = _modelCapabilities.settingsFor(
      channel.reasoningLevel || input.reasoningLevel || channelCapability.defaultReasoningLevel,
      channelCapability,
      channelProtocol,
    );
    return {
      ...channel,
      protocol: channel.protocol || "",
      reasoningLevel: channelSettings.reasoningLevel,
      reasoningEffort: channelSettings.reasoningEffort,
      thinkingEnabled: channelSettings.thinkingEnabled,
      thinkingBudget: channelSettings.thinkingBudget,
      capabilities: channelCapability,
      manualModel: oldChannel
        ? oldChannel.manualModel === true
        : !wasPresent,
    };
  });
  const now = new Date().toISOString();
  const record = {
    id,
    label: String(input.label || id).trim() || id,
    provider,
    upstreamModel,
    channels: storedChannels,
    protocol: input.protocol || storedChannels[0].protocol || providerCfg.protocol || "openai-chat",
    contextTokens: Number(input.contextTokens) || Number(capability.contextTokens) || 131072,
    maxOutputTokens: Number(input.maxOutputTokens) || 16384,
    supportsImages: input.supportsImages === true,
    capabilities: capability,
    reasoningLevel: settings.reasoningLevel,
    reasoningEffort: settings.reasoningEffort,
    thinkingEnabled: settings.thinkingEnabled,
    thinkingBudget: settings.thinkingBudget,
    toolCompatibility: capability.supportsTools === false ? "unsupported" : "compatible",
    channelStrategy: input.channelStrategy === "random" ? "random" : "priority",
    autoFallback: storedChannels.length > 1,
    manualModel: storedChannels[0].manualModel,
    createdAt: old ? old.createdAt : now,
    updatedAt: now,
  };
  _customModels[id] = record;
  for (const routeKey of [id, modelKey]) {
    if (_routes[routeKey] && _routes[routeKey]._customModelId === id)
      delete _routes[routeKey];
  }
  const routeResult = hotAddRoute(
    id,
    Object.assign(
      {
        provider,
        model: upstreamModel,
        sourceProtocol: record.protocol,
        maxOutputTokens: record.maxOutputTokens,
        contextStrategy: {
          enabled: false,
          mode: "devin-native",
          maxContextTokens: record.contextTokens,
        },
        _label: `${record.label} · 自定义模型`,
        _customModel: true,
        _customModelId: id,
        channelStrategy: record.channelStrategy,
        autoFallback: record.autoFallback,
        channelPriority: storedChannels.map((channel) => ({
          provider: channel.provider,
          model: channel.upstreamModel,
          protocol: channel.protocol,
          sourceProtocol: channel.protocol,
          reasoningLevel: channel.reasoningLevel,
          reasoningEffort: channel.reasoningEffort,
          thinkingEnabled: channel.thinkingEnabled,
          thinkingBudget: channel.thinkingBudget,
        })),
      },
      settings,
    ),
  );
  if (!routeResult.ok) {
    if (old) _customModels[id] = old;
    else delete _customModels[id];
    return routeResult;
  }
  _conversationProviderAffinity.clear();
  _customModelRuntime.delete(id);
  _hotSaveConfig();
  return { ok: true, model: record, route: _routes[id] };
}

function hotRemoveCustomModel(id) {
  id = String(id || "").trim();
  const record = _customModels[id];
  if (!record) return { ok: false, error: "custom model not found" };
  const protectedChannels = (Array.isArray(record.channels)
    ? record.channels
    : [record]
  ).filter((channel) => channel.manualModel === true);
  const references = Object.entries(_routes)
    .filter(
      ([uid, route]) =>
        uid !== id &&
        route &&
        route._customModelId !== id &&
        (route._customModelRef === id ||
          protectedChannels.some(
            (channel) =>
              route.provider === channel.provider &&
              route.model === (channel.upstreamModel || channel.model),
          )),
    )
    .map(([uid]) => uid);
  if (references.length)
    return { ok: false, error: "model is referenced by routes", references };
  const ownedRoute = _routes[id];
  if (ownedRoute && ownedRoute._customModelId === id) {
    const retiredRoute = {
      ...ownedRoute,
      _customModel: false,
      _customModelRetired: true,
      _hidden: true,
      _retiredAt: new Date().toISOString(),
      _label: `${record.label || id} · 已删除模型兼容路由`,
    };
    _routes[id] = retiredRoute;
    const modelKey = "MODEL_" + id.replace(/-/g, "_").toUpperCase();
    if (_routes[modelKey] && _routes[modelKey]._customModelId === id)
      _routes[modelKey] = retiredRoute;
  }
  const recordChannels = Array.isArray(record.channels)
    ? record.channels
    : [{
        provider: record.provider,
        upstreamModel: record.upstreamModel,
        manualModel: record.manualModel === true,
      }];
  for (const channel of recordChannels) {
    const providerCfg = _providers[channel.provider];
    if (!providerCfg || channel.manualModel !== true) continue;
    const stillUsed = Object.values(_customModels).some(
      (other) =>
        other &&
        other.id !== id &&
        (Array.isArray(other.channels) ? other.channels : [other]).some(
          (entry) =>
            entry.provider === channel.provider &&
            (entry.upstreamModel || entry.model) === channel.upstreamModel,
        ),
    );
    if (stillUsed) continue;
    providerCfg.models = (providerCfg.models || []).filter(
      (model) => model !== channel.upstreamModel,
    );
    if (providerCfg.modelCapabilities)
      delete providerCfg.modelCapabilities[channel.upstreamModel];
  }
  delete _customModels[id];
  _customModelRuntime.delete(id);
  _hotSaveConfig();
  return { ok: true, deleted: id };
}

function hotCustomModelCatalog() {
  if (!_modelCapabilities) return [];
  return hotListCustomModels().map((record) => _modelCapabilities.catalogEntry(record));
}

// ★ v9.9.97 · 热切换兼容别名 · source.js调用hotDeleteRoute

  return {
    list: hotListCustomModels,
    getCapability: hotGetModelCapability,
    upsert: hotUpsertCustomModel,
    remove: hotRemoveCustomModel,
    catalog: hotCustomModelCatalog,
  };
}

module.exports = { createCustomModelRegistry };

"use strict";

// Keep Codex pointed at one stable local Responses endpoint. The active
// provider/model/reasoning live in this small hot-reloaded state file.
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { stateFile } = require("../../../core/product_identity.js");

const CONFIG_PATH =
  stateFile("codex-hot-route.json") ||
  path.join(os.homedir(), ".fomo-flow", "codex-hot-route.json");
const LEVELS = new Set(["off", "low", "medium", "high", "xhigh"]);
// classic-forced: local host-off safe tools (default). catalog-passthrough: raw catalog.
const TOOL_SURFACES = new Set(["classic-forced", "catalog-passthrough"]);
const LOCAL_MODEL = "dao-codex-hot";
const LOCAL_PROVIDER = "dao_proxy_hot";
const LOCAL_PATH = "/codex-hot/v1";
const HANDOFF_PATH =
  stateFile("codex-cockpit-handoff.json") ||
  path.join(os.homedir(), ".fomo-flow", "codex-cockpit-handoff.json");
let _configGuardHandle = null;

function normalizeToolSurface(value) {
  const surface = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (surface === "passthrough" || surface === "catalog") {
    return "catalog-passthrough";
  }
  if (surface === "classic" || surface === "forced" || surface === "direct") {
    return "classic-forced";
  }
  return TOOL_SURFACES.has(surface) ? surface : "classic-forced";
}

function defaultConfig() {
  return {
    enabled: false,
    provider: "",
    model: "",
    protocol: "openai-responses",
    reasoningLevel: "medium",
    // Keep classic tools when code_mode_host is off (Codex Desktop local).
    toolSurface: "classic-forced",
    updatedAt: 0,
  };
}

function loadConfig(configPath) {
  const target = configPath || CONFIG_PATH;
  let cfg = defaultConfig();
  try {
    cfg = {
      ...cfg,
      ...(JSON.parse(fs.readFileSync(target, "utf8") || "{}") || {}),
    };
  } catch (_) {}
  if (!LEVELS.has(String(cfg.reasoningLevel))) cfg.reasoningLevel = "medium";
  cfg.toolSurface = normalizeToolSurface(cfg.toolSurface);
  if (cfg.enabled !== true && cfg.configGuardState === "managed") {
    cfg.configGuardState = "disabled";
    cfg.configGuardReason = "";
    cfg.lastObservedAt = 0;
    saveConfig(cfg, target);
  }
  return cfg;
}

function saveConfig(cfg, configPath) {
  const target = configPath || CONFIG_PATH;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + ".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        { ...defaultConfig(), ...cfg, updatedAt: Date.now() },
        null,
        2,
      ),
      "utf8",
    );
    fs.renameSync(tmp, target);
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeProtocol(value) {
  const protocol = String(value || "").trim().toLowerCase();
  if (protocol.includes("response")) return "openai-responses";
  if (protocol.includes("anthropic") || protocol.includes("claude")) {
    return "anthropic";
  }
  if (protocol.includes("gemini") || protocol.includes("google")) {
    return "gemini";
  }
  return "openai-chat";
}

function normalize(input, overview, statePath) {
  const cfg = { ...loadConfig(statePath), ...(input || {}) };
  const providers = (overview && overview.providers) || {};
  const provider = String(cfg.provider || "").trim();
  if (provider && !providers[provider]) {
    throw new Error("provider not found: " + provider);
  }
  if (!String(cfg.model || "").trim()) throw new Error("model required");
  cfg.provider = provider;
  cfg.model = String(cfg.model).trim();
  const providerConfig = providers[provider] || {};
  cfg.protocol = normalizeProtocol(
    cfg.protocol || providerConfig.protocol || providerConfig.type,
  );
  cfg.reasoningLevel = LEVELS.has(String(cfg.reasoningLevel))
    ? String(cfg.reasoningLevel)
    : "medium";
  cfg.toolSurface = normalizeToolSurface(cfg.toolSurface);
  cfg.enabled = cfg.enabled === true;
  return cfg;
}

/**
 * Mutate a Codex model catalog entry for classic tool mounting.
 * Only used when toolSurface === classic-forced.
 */
function applyClassicToolSurface(model) {
  if (!model || typeof model !== "object") return model;
  model.shell_type = model.shell_type || "shell_command";
  model.apply_patch_tool_type = model.apply_patch_tool_type || "freeform";
  if (model.supports_parallel_tool_calls == null) {
    model.supports_parallel_tool_calls = true;
  }
  if (
    model.tool_mode === "code_mode_only" ||
    model.tool_mode === "code_mode" ||
    !model.tool_mode
  ) {
    model.tool_mode = "direct";
  }
  if (model.use_responses_lite === true) {
    model.use_responses_lite = false;
  }
  return model;
}

/**
 * Health of Codex tool surface for HUD / status.
 * Red when host is off but catalog/API still advertise code_mode_only.
 */
function probeCodexToolSurfaceHealth(options) {
  const opts = options || {};
  const codexHome =
    opts.codexHome ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex");
  const configPath =
    opts.configPath || path.join(codexHome, "config.toml");
  const hot = loadConfig(opts.statePath);
  const toolSurface = normalizeToolSurface(
    opts.toolSurface || hot.toolSurface,
  );

  let codeModeHost = false;
  let modelCatalogJson = "";
  let configText = "";
  try {
    configText = fs.readFileSync(configPath, "utf8");
    const hostMatch = configText.match(/^\s*code_mode_host\s*=\s*(\w+)/m);
    codeModeHost =
      hostMatch && String(hostMatch[1]).toLowerCase() === "true";
    const catMatch = configText.match(
      /^\s*model_catalog_json\s*=\s*"([^"]+)"/m,
    );
    modelCatalogJson = catMatch ? catMatch[1] : "";
  } catch (_) {}

  let diskToolMode = "";
  let diskLite = null;
  const catalogCandidates = [
    modelCatalogJson,
    "dao-codex-model-catalog.json",
    "cockpit-local-access-model-catalog.json",
    "models_cache.json",
  ].filter(Boolean);
  for (const name of catalogCandidates) {
    const file = path.isAbsolute(name) ? name : path.join(codexHome, name);
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const models = (data && data.models) || [];
      const sol =
        models.find((m) => m && m.slug === "gpt-5.6-sol") || models[0];
      if (sol) {
        diskToolMode = String(sol.tool_mode || "");
        diskLite = sol.use_responses_lite === true;
        break;
      }
    } catch (_) {}
  }

  const apiToolMode = String(opts.apiToolMode || diskToolMode || "");
  const apiLite =
    opts.apiUseResponsesLite != null
      ? opts.apiUseResponsesLite === true
      : diskLite;
  const effectiveMode = apiToolMode || diskToolMode || "unknown";
  const classicOk =
    effectiveMode === "direct" ||
    effectiveMode === "" ||
    effectiveMode === "unknown";
  // Dangerous: code mode required but host disabled → zero classic tools
  const zeroToolRisk =
    !codeModeHost &&
    (effectiveMode === "code_mode_only" || effectiveMode === "code_mode");

  let state = "ok";
  let reason = "";
  if (zeroToolRisk) {
    state = "critical";
    reason = "code_mode_without_host";
  } else if (toolSurface === "catalog-passthrough" && !codeModeHost) {
    state = "warn";
    reason = "passthrough_host_off";
  } else if (toolSurface === "classic-forced" && !classicOk && !zeroToolRisk) {
    state = "warn";
    reason = "catalog_not_direct";
  }

  return {
    state,
    reason,
    toolSurface,
    codeModeHost,
    modelCatalogJson: modelCatalogJson || null,
    diskToolMode: diskToolMode || null,
    apiToolMode: apiToolMode || null,
    useResponsesLite: apiLite,
    zeroToolRisk,
    classicForced: toolSurface === "classic-forced",
  };
}

function quoteToml(value) {
  return (
    '"' +
    String(value == null ? "" : value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n") +
    '"'
  );
}

function sectionBounds(lines, sectionName) {
  const heading = "[" + sectionName + "]";
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function setTopLevel(lines, key, valueLine) {
  const firstSection = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
  const limit = firstSection < 0 ? lines.length : firstSection;
  const pattern = new RegExp(
    "^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=",
  );
  const matches = [];
  for (let index = 0; index < limit; index += 1) {
    if (pattern.test(lines[index])) matches.push(index);
  }
  if (matches.length) {
    lines[matches[0]] = valueLine;
    for (let index = matches.length - 1; index >= 1; index -= 1) {
      lines.splice(matches[index], 1);
    }
  } else {
    lines.splice(limit, 0, valueLine);
  }
}

function setSection(lines, sectionName, bodyLines) {
  const bounds = sectionBounds(lines, sectionName);
  const replacement = ["[" + sectionName + "]", ...bodyLines, ""];
  if (bounds) {
    lines.splice(bounds.start, bounds.end - bounds.start, ...replacement);
    return;
  }
  if (lines.length && lines[lines.length - 1].trim()) lines.push("");
  lines.push(...replacement);
}

function isManagedText(text, baseUrl, providerName) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
  const topEnd = firstSection < 0 ? lines.length : firstSection;
  const activeProvider = String(
    providerName || parseTomlScalar(lines, "model_provider", 0, topEnd) || "",
  );
  const bounds = providerSectionBounds(lines, activeProvider);
  return !!(
    bounds &&
    String(parseTomlScalar(lines, "base_url", bounds.start, bounds.end) || "").replace(/\/$/, "") ===
      String(baseUrl || "").replace(/\/$/, "") &&
    parseTomlScalar(lines, "experimental_bearer_token", bounds.start, bounds.end)
  );
}

function parseTomlScalar(lines, key, start, end) {
  const pattern = new RegExp(
    "^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=\\s*(.*?)\\s*$",
  );
  for (let index = start || 0; index < (end == null ? lines.length : end); index += 1) {
    const match = String(lines[index] || "").match(pattern);
    if (!match) continue;
    const raw = match[1].replace(/\s+#.*$/, "").trim();
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        return JSON.parse(raw);
      } catch (_) {
        return raw.slice(1, -1);
      }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw;
  }
  return "";
}

function providerSectionBounds(lines, providerName) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = String(lines[index] || "").trim().match(
      /^\[model_providers\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]$/,
    );
    const name = match && (match[1] || match[2] || match[3] || "").trim();
    if (name !== providerName) continue;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^\s*\[[^\]]+\]\s*$/.test(lines[next])) {
        end = next;
        break;
      }
    }
    return { start: index + 1, end };
  }
  return null;
}

function setSectionScalar(lines, providerName, key, valueLine) {
  const bounds = providerSectionBounds(lines, providerName);
  if (!bounds) throw new Error("Codex provider section not found: " + providerName);
  const pattern = new RegExp(
    "^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=",
  );
  const matches = [];
  for (let index = bounds.start; index < bounds.end; index += 1) {
    if (pattern.test(lines[index])) matches.push(index);
  }
  if (matches.length) {
    lines[matches[0]] = valueLine;
    for (let index = matches.length - 1; index >= 1; index -= 1) {
      lines.splice(matches[index], 1);
    }
  } else {
    lines.splice(bounds.end, 0, valueLine);
  }
}

function appendProviderSectionFromText(lines, providerName, sourceText) {
  const sourceLines = String(sourceText || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const bounds = providerSectionBounds(sourceLines, providerName);
  if (!bounds) return false;
  const heading = bounds.start - 1;
  const body = sourceLines.slice(heading, bounds.end);
  if (lines.length && lines[lines.length - 1].trim()) lines.push("");
  lines.push(...body, "");
  return true;
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function readProviderConnectionText(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
  const topEnd = firstSection < 0 ? lines.length : firstSection;
  const providerName = String(
    parseTomlScalar(lines, "model_provider", 0, topEnd) || "",
  );
  const bounds = providerSectionBounds(lines, providerName);
  if (!bounds) throw new Error("Codex provider section not found: " + providerName);
  return {
    providerName,
    model: String(parseTomlScalar(lines, "model", 0, topEnd) || ""),
    baseUrl: String(
      parseTomlScalar(lines, "base_url", bounds.start, bounds.end) || "",
    ),
    bearerToken: String(
      parseTomlScalar(
        lines,
        "experimental_bearer_token",
        bounds.start,
        bounds.end,
      ) || "",
    ),
    wireApi: String(
      parseTomlScalar(lines, "wire_api", bounds.start, bounds.end) || "",
    ),
  };
}

function readProviderConnection(configPath) {
  return readProviderConnectionText(fs.readFileSync(configPath, "utf8"));
}

function writePrivateJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
}

function restoreCodexConfig(options) {
  const configPath =
    (options && options.configPath) ||
    path.join(os.homedir(), ".codex", "config.toml");
  const handoffPath = (options && options.handoffPath) || HANDOFF_PATH;
  let handoff;
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
  } catch (_) {
    return { ok: false, reason: "handoff-missing" };
  }
  if (
    !handoff ||
    handoff.version !== 1 ||
    !handoff.original ||
    !handoff.managed
  ) {
    return { ok: false, reason: "handoff-invalid" };
  }

  let current;
  try {
    current = readProviderConnection(configPath);
  } catch (_) {
    return { ok: false, reason: "config-unreadable" };
  }
  if (
    current.providerName !== handoff.providerName ||
    current.baseUrl.replace(/\/$/, "") !==
      String(handoff.managed.baseUrl || "").replace(/\/$/, "") ||
    sha256(current.bearerToken) !== handoff.managed.bearerTokenHash
  ) {
    return { ok: false, reason: "config-drift" };
  }

  const original = fs.readFileSync(configPath, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.replace(/^\uFEFF/, "").split(/\r?\n/);
  setSectionScalar(
    lines,
    current.providerName,
    "base_url",
    "base_url = " + quoteToml(handoff.original.baseUrl || ""),
  );
  setSectionScalar(
    lines,
    current.providerName,
    "experimental_bearer_token",
    "experimental_bearer_token = " +
      quoteToml(handoff.original.bearerToken || ""),
  );
  const next = lines.join(newline).replace(/(?:\r?\n){3,}$/g, newline + newline);
  const changed = next !== original;
  if (changed) {
    const tmp = configPath + ".dao-proxy-pro.tmp";
    fs.writeFileSync(tmp, next, "utf8");
    fs.renameSync(tmp, configPath);
  }
  try {
    fs.unlinkSync(handoffPath);
  } catch (_) {}
  return {
    ok: true,
    changed,
    restartRequired: changed,
    providerName: current.providerName,
  };
}

function ensureCockpitProvider(runtime, connection, name = "cockpit-codex") {
  if (!runtime || typeof runtime.hotSetConfig !== "function") {
    throw new Error("router hot config unavailable");
  }
  let parsed;
  try {
    parsed = new URL(String(connection && connection.baseUrl || ""));
  } catch (_) {
    throw new Error("Cockpit provider Base URL invalid");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Cockpit provider must use a loopback Base URL");
  }
  if (connection.wireApi && connection.wireApi !== "responses") {
    throw new Error("Cockpit provider wire_api must be responses");
  }
  if (!connection.bearerToken) {
    throw new Error("Cockpit provider token missing");
  }
  const model = String(connection.model || "gpt-5.6-sol");
  const result = runtime.hotSetConfig({
    providers: {
      [name]: {
        label: "Cockpit Codex",
        baseUrl: String(connection.baseUrl).replace(/\/$/, ""),
        apiKey: connection.bearerToken,
        protocol: "openai-responses",
        streamMode: "stream",
        models: [model],
      },
    },
  });
  if (!result || result.ok !== true) {
    throw new Error(
      "Cockpit provider import failed: " +
        String(result && result.error || "unknown"),
    );
  }
  return { ok: true, name, model };
}

function importConnection(configPath, handoffPath, managedBaseUrl) {
  const current = readProviderConnection(configPath);
  if (
    current.baseUrl.replace(/\/$/, "") !==
    String(managedBaseUrl || "").replace(/\/$/, "")
  ) {
    return current;
  }
  try {
    const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
    if (
      handoff &&
      handoff.version === 1 &&
      handoff.providerName === current.providerName &&
      handoff.original &&
      handoff.original.baseUrl &&
      handoff.original.bearerToken
    ) {
      return {
        ...current,
        baseUrl: String(handoff.original.baseUrl),
        bearerToken: String(handoff.original.bearerToken),
      };
    }
  } catch (_) {}
  throw new Error("Cockpit handoff unavailable for managed Codex config");
}

function disable(options) {
  const statePath = options && options.statePath;
  const restored = restoreCodexConfig(options || {});
  if (!restored.ok) return restored;
  const current = loadConfig(statePath);
  const next = {
    ...current,
    enabled: false,
    configGuardState: "disabled",
    configGuardReason: "",
    lastObservedAt: 0,
    restartRequired: restored.restartRequired === true,
  };
  if (!saveConfig(next, statePath)) {
    return { ok: false, reason: "state-write-failed" };
  }
  return restored;
}

function markObserved(input, options) {
  const statePath = options && options.statePath;
  const current = loadConfig(statePath);
  if (!current.enabled) return { ok: false, reason: "route-disabled" };
  const at = Number(input && input.at) || Date.now();
  const next = {
    ...current,
    lastObservedAt: at,
    restartRequired: false,
  };
  return saveConfig(next, statePath)
    ? { ok: true, lastObservedAt: at, restartRequired: false }
    : { ok: false, reason: "state-write-failed" };
}

function readCodexConfigSnapshot(configPath) {
  const target = configPath || path.join(os.homedir(), ".codex", "config.toml");
  const empty = {
    exists: false,
    modelProvider: "",
    model: "",
    reasoningLevel: "",
    baseUrl: "",
    wireApi: "",
    requiresOpenAIAuth: false,
    hasProviderToken: false,
    modifiedAt: 0,
  };
  try {
    const text = fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "");
    const lines = text.split(/\r?\n/);
    const firstSection = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
    const topEnd = firstSection < 0 ? lines.length : firstSection;
    const modelProvider = String(parseTomlScalar(lines, "model_provider", 0, topEnd) || "");
    const providerBounds = providerSectionBounds(lines, modelProvider);
    const providerStart = providerBounds ? providerBounds.start : 0;
    const providerEnd = providerBounds ? providerBounds.end : 0;
    return {
      exists: true,
      modelProvider,
      model: String(parseTomlScalar(lines, "model", 0, topEnd) || ""),
      reasoningLevel: String(
        parseTomlScalar(lines, "model_reasoning_effort", 0, topEnd) || "",
      ),
      baseUrl: providerBounds
        ? String(parseTomlScalar(lines, "base_url", providerStart, providerEnd) || "")
        : "",
      wireApi: providerBounds
        ? String(parseTomlScalar(lines, "wire_api", providerStart, providerEnd) || "")
        : "",
      requiresOpenAIAuth: providerBounds
        ? parseTomlScalar(lines, "requires_openai_auth", providerStart, providerEnd) === true
        : false,
      hasProviderToken: providerBounds
        ? !!parseTomlScalar(lines, "experimental_bearer_token", providerStart, providerEnd)
        : false,
      modifiedAt: fs.statSync(target).mtimeMs || 0,
    };
  } catch (_) {
    return empty;
  }
}

function patchCodexConfig(options) {
  const configPath =
    (options && options.configPath) ||
    path.join(os.homedir(), ".codex", "config.toml");
  const baseUrl = String((options && options.baseUrl) || "").replace(/\/$/, "");
  const apiKey = String((options && options.apiKey) || "");
  const handoffPath = (options && options.handoffPath) || HANDOFF_PATH;
  if (!baseUrl) throw new Error("Codex local base URL required");
  if (!apiKey) throw new Error("Codex local API key required");

  const existed = fs.existsSync(configPath);
  const original = existed ? fs.readFileSync(configPath, "utf8") : "";
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original ? original.replace(/^\uFEFF/, "").split(/\r?\n/) : [];
  const firstSection = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
  const topEnd = firstSection < 0 ? lines.length : firstSection;
  let providerName = String(parseTomlScalar(lines, "model_provider", 0, topEnd) || "");
  let migratedLegacyTakeover = false;
  const currentModel = String(parseTomlScalar(lines, "model", 0, topEnd) || "");
  const backupPath = configPath + ".dao-proxy-pro.bak";
  if (
    providerName === LOCAL_PROVIDER &&
    currentModel === LOCAL_MODEL &&
    fs.existsSync(backupPath)
  ) {
    const backupText = fs.readFileSync(backupPath, "utf8");
    const backupSnapshot = readCodexConfigSnapshot(backupPath);
    if (backupSnapshot.modelProvider && backupSnapshot.model) {
      providerName = backupSnapshot.modelProvider;
      setTopLevel(lines, "model_provider", "model_provider = " + quoteToml(providerName));
      setTopLevel(lines, "model", "model = " + quoteToml(backupSnapshot.model));
      if (backupSnapshot.reasoningLevel) {
        setTopLevel(
          lines,
          "model_reasoning_effort",
          "model_reasoning_effort = " + quoteToml(backupSnapshot.reasoningLevel),
        );
      }
      if (!providerSectionBounds(lines, providerName)) {
        appendProviderSectionFromText(lines, providerName, backupText);
      }
      migratedLegacyTakeover = true;
    }
  }
  if (!providerName) throw new Error("Codex model_provider is not configured");
  const bounds = providerSectionBounds(lines, providerName);
  if (!bounds) throw new Error("Codex provider section not found: " + providerName);
  const wireApi = String(parseTomlScalar(lines, "wire_api", bounds.start, bounds.end) || "");
  if (wireApi && wireApi !== "responses") {
    throw new Error("Codex current provider wire_api must be responses");
  }
  const alreadyManaged = isManagedText(original, baseUrl, providerName);
  if (!alreadyManaged && !fs.existsSync(handoffPath)) {
    const connection = readProviderConnectionText(lines.join(newline));
    writePrivateJson(handoffPath, {
      version: 1,
      providerName: connection.providerName,
      original: {
        baseUrl: connection.baseUrl,
        bearerToken: connection.bearerToken,
      },
      managed: {
        baseUrl,
        bearerTokenHash: sha256(apiKey),
      },
      activatedAt: Date.now(),
    });
  }
  setSectionScalar(lines, providerName, "base_url", "base_url = " + quoteToml(baseUrl));
  setSectionScalar(
    lines,
    providerName,
    "experimental_bearer_token",
    "experimental_bearer_token = " + quoteToml(apiKey),
  );
  const next = lines.join(newline).replace(/(?:\r?\n){3,}$/g, newline + newline);
  const changed = next !== original;
  if (changed) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (existed && !fs.existsSync(backupPath)) {
      fs.copyFileSync(configPath, backupPath);
    }
    const tmp = configPath + ".dao-proxy-pro.tmp";
    fs.writeFileSync(tmp, next, "utf8");
    fs.renameSync(tmp, configPath);
  }
  return {
    ok: true,
    configPath,
    changed,
    alreadyManaged,
    providerName,
    migratedLegacyTakeover,
    restartRequired: changed && !alreadyManaged,
  };
}

function _saveGuardState(current, statePath, input) {
  const next = {
    ...current,
    configGuardState: String(input.state || ""),
    configGuardReason: String(input.reason || ""),
    configGuardCheckedAt: Number(input.checkedAt) || 0,
    configGuardRepairedAt:
      Number(input.repairedAt) || Number(current.configGuardRepairedAt) || 0,
  };
  if (input.restartRequired === true) next.restartRequired = true;
  if (input.clearObservation === true) next.lastObservedAt = 0;
  const unchanged =
    current.configGuardState === next.configGuardState &&
    current.configGuardReason === next.configGuardReason &&
    Number(current.configGuardRepairedAt || 0) === next.configGuardRepairedAt &&
    current.restartRequired === next.restartRequired &&
    Number(current.lastObservedAt || 0) === Number(next.lastObservedAt || 0);
  if (unchanged) return true;
  return saveConfig(next, statePath);
}

function reconcileCodexConfig(options) {
  const opts = options || {};
  const statePath = opts.statePath;
  const currentState = loadConfig(statePath);
  const checkedAt = Number(opts.now) || Date.now();
  const priorRepairAt = Number(currentState.configGuardRepairedAt) || 0;
  const result = (state, ok, extra) => ({
    ok,
    state,
    changed: false,
    restartRequired: currentState.restartRequired === true,
    checkedAt,
    repairedAt: priorRepairAt,
    ...(extra || {}),
  });
  if (!currentState.enabled) return result("disabled", true);

  const configPath =
    opts.configPath ||
    currentState.configPath ||
    path.join(os.homedir(), ".codex", "config.toml");
  const handoffPath = opts.handoffPath || HANDOFF_PATH;
  const managedBaseUrl = normalizeBaseUrl(opts.baseUrl || currentState.baseUrl);
  const apiKey = String(opts.apiKey || "");
  if (!managedBaseUrl || !apiKey) {
    return result("unavailable", false, { reason: "guard-input-missing" });
  }

  let handoff;
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
  } catch (_) {
    return result("unavailable", false, { reason: "handoff-missing" });
  }
  if (
    !handoff ||
    handoff.version !== 1 ||
    !handoff.providerName ||
    !handoff.original ||
    !handoff.managed
  ) {
    return result("unavailable", false, { reason: "handoff-invalid" });
  }
  const handoffManagedUrl = normalizeBaseUrl(handoff.managed.baseUrl);
  const managedTokenHash = String(handoff.managed.bearerTokenHash || "");
  if (
    managedBaseUrl !== handoffManagedUrl ||
    !managedTokenHash ||
    sha256(apiKey) !== managedTokenHash
  ) {
    return result("drift", false, { reason: "guard-input-drift" });
  }

  let connection;
  try {
    connection = readProviderConnection(configPath);
  } catch (_) {
    return result("unavailable", false, { reason: "config-unreadable" });
  }
  if (connection.providerName !== handoff.providerName) {
    return result("drift", false, { reason: "provider-changed" });
  }

  const currentUrl = normalizeBaseUrl(connection.baseUrl);
  const currentTokenHash = sha256(connection.bearerToken);
  const originalUrl = normalizeBaseUrl(handoff.original.baseUrl);
  const originalTokenHash = sha256(handoff.original.bearerToken);
  const knownUrl = currentUrl === handoffManagedUrl || currentUrl === originalUrl;
  const knownToken =
    currentTokenHash === managedTokenHash ||
    currentTokenHash === originalTokenHash;
  if (!knownUrl || !knownToken) {
    _saveGuardState(currentState, statePath, {
      state: "drift",
      reason: "unknown-managed-values",
      checkedAt,
      repairedAt: priorRepairAt,
    });
    return result("drift", false, { reason: "unknown-managed-values" });
  }

  if (currentUrl === handoffManagedUrl && currentTokenHash === managedTokenHash) {
    // Keep tool surface healthy while managed (Cockpit rewrites catalogs).
    try {
      ensureDirectToolCatalogs({ configPath });
    } catch (_) {}
    _saveGuardState(currentState, statePath, {
      state: "managed",
      reason: "",
      checkedAt,
      repairedAt: priorRepairAt,
    });
    return result("managed", true);
  }

  let patched;
  try {
    patched = patchCodexConfig({
      configPath,
      handoffPath,
      baseUrl: managedBaseUrl,
      apiKey,
    });
  } catch (_) {
    return result("unavailable", false, { reason: "repair-failed" });
  }
  if (!patched || patched.ok !== true || patched.changed !== true) {
    return result("unavailable", false, { reason: "repair-not-applied" });
  }
  if (
    !_saveGuardState(currentState, statePath, {
      state: "repaired",
      reason: "known-upstream-reset",
      checkedAt,
      repairedAt: checkedAt,
      restartRequired: true,
      clearObservation: true,
    })
  ) {
    return result("unavailable", false, { reason: "state-write-failed" });
  }
  try {
    ensureDirectToolCatalogs({ configPath });
  } catch (_) {}
  return {
    ok: true,
    state: "repaired",
    changed: true,
    restartRequired: true,
    checkedAt,
    repairedAt: checkedAt,
  };
}

/**
 * While hot route is managed, Cockpit may rewrite model_catalog_json to a
 * code_mode_only catalog. With code_mode_host disabled that leaves Codex with
 * zero classic tools. Keep on-disk catalogs + config pins on direct tools.
 */
function ensureDirectToolCatalogs(options) {
  const opts = options || {};
  const codexHome =
    opts.codexHome ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex");
  const result = {
    ok: true,
    catalogsFixed: [],
    configFixed: false,
    skipped: false,
  };
  const surface = normalizeToolSurface(
    opts.toolSurface || loadConfig(opts.statePath).toolSurface,
  );
  // Passthrough mode: do not rewrite on-disk catalog tool modes.
  if (surface === "catalog-passthrough") {
    result.skipped = true;
    return result;
  }
  const catalogNames = [
    "dao-codex-model-catalog.json",
    "cockpit-local-access-model-catalog.json",
    "models_cache.json",
  ];
  for (const name of catalogNames) {
    const file = path.join(codexHome, name);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {
      continue;
    }
    if (!data || !Array.isArray(data.models)) continue;
    let changed = false;
    for (const model of data.models) {
      if (!model || typeof model !== "object") continue;
      if (
        model.tool_mode === "code_mode_only" ||
        model.tool_mode === "code_mode" ||
        !model.tool_mode
      ) {
        model.tool_mode = "direct";
        changed = true;
      }
      if (model.use_responses_lite === true) {
        model.use_responses_lite = false;
        changed = true;
      }
      if (!model.shell_type) {
        model.shell_type = "shell_command";
        changed = true;
      }
      if (!model.apply_patch_tool_type) {
        model.apply_patch_tool_type = "freeform";
        changed = true;
      }
      if (model.supports_parallel_tool_calls == null) {
        model.supports_parallel_tool_calls = true;
        changed = true;
      }
    }
    if (changed) {
      try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
        result.catalogsFixed.push(name);
      } catch (_) {
        result.ok = false;
      }
    }
  }

  const configPath =
    opts.configPath || path.join(codexHome, "config.toml");
  try {
    let text = fs.readFileSync(configPath, "utf8");
    const original = text;
    if (/model_catalog_json\s*=/.test(text)) {
      text = text.replace(
        /model_catalog_json\s*=\s*"[^"]*"/,
        'model_catalog_json = "dao-codex-model-catalog.json"',
      );
    }
    for (const key of [
      "code_mode",
      "code_mode_only",
      "code_mode_buffered_exec",
      "code_mode_host",
    ]) {
      text = text.replace(
        new RegExp("^" + key + "\\s*=\\s*\\S+", "m"),
        key + " = false",
      );
    }
    if (/^apply_patch_freeform\s*=/m.test(text)) {
      text = text.replace(
        /^apply_patch_freeform\s*=\s*\S+/m,
        "apply_patch_freeform = true",
      );
    }
    if (text !== original) {
      fs.writeFileSync(configPath, text, "utf8");
      result.configFixed = true;
    }
  } catch (_) {
    /* config optional */
  }
  return result;
}

function stopConfigGuard() {
  if (_configGuardHandle && typeof _configGuardHandle.stop === "function") {
    _configGuardHandle.stop();
  }
  _configGuardHandle = null;
}

function startConfigGuard(options) {
  const opts = options || {};
  stopConfigGuard();
  const intervalMs = Math.max(500, Number(opts.intervalMs) || 2000);
  const initialDelayMs = Math.max(100, Number(opts.initialDelayMs) || 1200);
  const reconcile =
    typeof opts.reconcile === "function"
      ? opts.reconcile
      : reconcileCodexConfig;
  const getApiKey =
    typeof opts.getApiKey === "function" ? opts.getApiKey : () => "";
  const log = typeof opts.log === "function" ? opts.log : () => {};
  let stopped = false;
  let busy = false;
  let initialTimer = null;
  let intervalTimer = null;
  let lastSignature = "";

  const tick = async () => {
    if (stopped) return { ok: false, state: "stopped", changed: false };
    if (busy) return { ok: false, state: "busy", changed: false };
    busy = true;
    let result;
    try {
      result = await Promise.resolve(
        reconcile({
          configPath: opts.configPath,
          statePath: opts.statePath,
          handoffPath: opts.handoffPath,
          baseUrl: opts.baseUrl,
          apiKey: String(getApiKey() || ""),
          now: Date.now(),
        }),
      );
    } catch (_) {
      result = {
        ok: false,
        state: "error",
        changed: false,
        reason: "reconcile-failed",
      };
    } finally {
      busy = false;
    }
    const safe = result && typeof result === "object"
      ? result
      : { ok: false, state: "error", changed: false, reason: "invalid-result" };
    const signature = [
      safe.ok === true ? "ok" : "fail",
      String(safe.state || "unknown"),
      String(safe.reason || ""),
    ].join(":");
    if (safe.changed === true || signature !== lastSignature) {
      const suffix = safe.reason ? " · " + String(safe.reason) : "";
      log(
        "[codex-config-guard] " +
          String(safe.state || "unknown") +
          (safe.changed === true ? " · repaired" : "") +
          suffix,
      );
      lastSignature = signature;
    }
    return safe;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
  };
  initialTimer = setTimeout(() => {
    void tick();
  }, initialDelayMs);
  intervalTimer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (initialTimer.unref) initialTimer.unref();
  if (intervalTimer.unref) intervalTimer.unref();

  const handle = { intervalMs, initialDelayMs, tick, stop };
  _configGuardHandle = handle;
  return handle;
}

function apply(input, runtime, revproxy, port, options) {
  if (!runtime || !runtime.hotGetConfig) {
    throw new Error("router runtime not loaded");
  }
  if (!revproxy || !revproxy.loadConfig || !revproxy.saveConfig) {
    throw new Error("reverse proxy runtime not loaded");
  }
  const requested = { ...(input || {}) };
  let upstreamImported = false;
  if (requested.importCurrentProvider === true) {
    const configPath =
      (options && options.configPath) ||
      path.join(os.homedir(), ".codex", "config.toml");
    const connection = importConnection(
      configPath,
      (options && options.handoffPath) || HANDOFF_PATH,
      "http://127.0.0.1:" + Number(port || 0) + LOCAL_PATH,
    );
    const imported = ensureCockpitProvider(
      runtime,
      connection,
      String(requested.provider || "cockpit-codex"),
    );
    requested.provider = imported.name;
    if (!requested.model) requested.model = imported.model;
    if (!requested.protocol) requested.protocol = "openai-responses";
    upstreamImported = true;
  }
  const overview = runtime.hotGetConfig();
  const statePath = options && options.statePath;
  // Default local safety: classic tools unless caller explicitly opts into passthrough.
  if (requested.toolSurface == null || requested.toolSurface === "") {
    requested.toolSurface = "classic-forced";
  }
  const cfg = normalize({ ...requested, enabled: true }, overview, statePath);
  const providerConfig = overview.providers[cfg.provider] || {};
  if (!providerConfig.apiKey && !providerConfig.apiKeys) {
    throw new Error("selected provider has no API key");
  }
  const reasoningOff = cfg.reasoningLevel === "off";
  const route = {
    provider: cfg.provider,
    model: cfg.model,
    protocol: cfg.protocol,
    sourceProtocol: cfg.protocol,
    reasoningLevel: cfg.reasoningLevel,
    reasoningEffort: reasoningOff ? null : cfg.reasoningLevel,
    thinkingEnabled: !reasoningOff,
    maxOutputTokens: Number(requested.maxOutputTokens) || 16384,
    autoFallback: false,
    enabled: true,
    _codexManaged: true,
    _label: "Codex Hot Route",
  };
  const reverseConfig = revproxy.loadConfig();
  reverseConfig.enabled = true;
  if (!revproxy.saveConfig(reverseConfig)) {
    throw new Error("reverse proxy config write failed");
  }
  const baseUrl = "http://127.0.0.1:" + Number(port || 0) + LOCAL_PATH;
  const codexResult = patchCodexConfig({
    ...(options || {}),
    baseUrl,
    apiKey: reverseConfig.apiKey,
    reasoningLevel: cfg.reasoningLevel,
  });
  // Pin tool surface while enabling so Cockpit-only catalogs cannot leave host-off zero-tools.
  let toolCatalog = { ok: true, catalogsFixed: [], configFixed: false, skipped: false };
  try {
    toolCatalog = ensureDirectToolCatalogs({
      configPath: codexResult.configPath,
      statePath,
      toolSurface: cfg.toolSurface,
    });
  } catch (_) {}
  const saved = {
    ...cfg,
    toolSurface: normalizeToolSurface(cfg.toolSurface),
    route,
    enabled: true,
    codexModel: readCodexConfigSnapshot(codexResult.configPath).model,
    codexProvider: codexResult.providerName,
    baseUrl,
    configPath: codexResult.configPath,
    handoffPath: (options && options.handoffPath) || HANDOFF_PATH,
    restartRequired: codexResult.restartRequired,
    upstreamImported,
    toolCatalog,
  };
  if (!saveConfig(saved, statePath)) throw new Error("bridge state write failed");
  return { ok: true, config: saved, codex: codexResult };
}

function setConfig(input, overview, options) {
  const statePath = options && options.statePath;
  const cfg = normalize(input, overview, statePath);
  return saveConfig(cfg, statePath)
    ? { ok: true, config: cfg }
    : { ok: false, error: "write failed" };
}

function status(port, overview, options) {
  const cfg = loadConfig(options && options.statePath);
  const baseUrl = port ? "http://127.0.0.1:" + port + LOCAL_PATH : "";
  const configPath =
    cfg.configPath || path.join(os.homedir(), ".codex", "config.toml");
  const codexObserved = readCodexConfigSnapshot(configPath);
  let managedTokenHash = "";
  try {
    const handoffPath =
      (options && options.handoffPath) || cfg.handoffPath || HANDOFF_PATH;
    const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
    managedTokenHash = String(
      handoff && handoff.managed && handoff.managed.bearerTokenHash || "",
    );
  } catch (_) {}
  let observedTokenHash = "";
  try {
    observedTokenHash = readProviderConnection(configPath).bearerToken;
  } catch (_) {}
  const codexConfigManaged =
    cfg.enabled === true &&
    !!baseUrl &&
    codexObserved.baseUrl.replace(/\/$/, "") === baseUrl &&
    !!managedTokenHash &&
    !!observedTokenHash &&
    sha256(observedTokenHash) === managedTokenHash;
  const routeActive = !!(
    cfg.enabled &&
    cfg.provider &&
    cfg.model &&
    overview &&
    overview.providers &&
    overview.providers[cfg.provider]
  );
  const toolSurfaceHealth = probeCodexToolSurfaceHealth({
    configPath,
    statePath: options && options.statePath,
    toolSurface: cfg.toolSurface,
  });
  return {
    ok: true,
    ...cfg,
    toolSurface: normalizeToolSurface(cfg.toolSurface),
    toolSurfaceHealth,
    endpoint: port
      ? "http://127.0.0.1:" + port + LOCAL_PATH + "/responses"
      : "",
    baseUrl,
    configPath,
    codexConfigManaged,
    routeActive,
    providerConfigured:
      !cfg.provider ||
      !!(overview && overview.providers && overview.providers[cfg.provider]),
    localModel: codexObserved.model || cfg.codexModel || "",
    localProvider: codexObserved.modelProvider || cfg.codexProvider || "",
    codexObserved,
    preservation: {
      scope: "config-only",
      authenticationTouched: false,
      historyTouched: false,
      // Codex path: do not rewrite prompts / tool schemas; only base_url + tool surface pins.
      promptContractUntouched: true,
    },
  };
}

module.exports = {
  CONFIG_PATH,
  HANDOFF_PATH,
  LEVELS: Array.from(LEVELS),
  TOOL_SURFACES: Array.from(TOOL_SURFACES),
  LOCAL_MODEL,
  LOCAL_PROVIDER,
  LOCAL_PATH,
  defaultConfig,
  normalizeProtocol,
  normalizeToolSurface,
  loadConfig,
  saveConfig,
  setConfig,
  status,
  patchCodexConfig,
  restoreCodexConfig,
  readProviderConnection,
  ensureCockpitProvider,
  disable,
  markObserved,
  readCodexConfigSnapshot,
  isManagedText,
  reconcileCodexConfig,
  ensureDirectToolCatalogs,
  applyClassicToolSurface,
  probeCodexToolSurfaceHealth,
  startConfigGuard,
  stopConfigGuard,
  apply,
};

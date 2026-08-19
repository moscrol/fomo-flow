"use strict";

const { execFileSync } = require("node:child_process");
const os = require("node:os");

const DEFAULT_BASE_URL = "https://mirasim-relay.mirofish.ai";
const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const ANTHROPIC_VERSION = "2023-06-01";

function keychainToken(service = "mirasim-direct-relay") {
  try {
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", os.userInfo().username, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "";
  }
}

function loadRelayToken() {
  const token = String(process.env.MIRASIM_RELAY_TOKEN || "").trim() || keychainToken();
  if (!token) throw new Error("MIRASIM_RELAY_TOKEN or Keychain service mirasim-direct-relay is required for direct relay transport");
  return token;
}

function relayBaseUrl(value) {
  const raw = String(value || process.env.MIRASIM_RELAY_BASE_URL || DEFAULT_BASE_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("MIRASIM_RELAY_BASE_URL must be an absolute URL");
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("MIRASIM relay URL must use HTTP(S)");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === "text" || part.type === "input_text") && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function anthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part && typeof part === "object").map((part) => {
    if (part.type === "text" || part.type === "input_text") return { type: "text", text: String(part.text || "") };
    return part;
  });
}

function pushAnthropicMessage(output, role, content) {
  if (!content || (Array.isArray(content) && !content.length)) return;
  const last = output[output.length - 1];
  if (last && last.role === role && Array.isArray(last.content) && Array.isArray(content)) {
    last.content.push(...content);
    return;
  }
  output.push({ role, content });
}

function toAnthropicMessages(messages) {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  const output = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : message.role;
    if (role === "system") continue;
    if (role === "tool") {
      pushAnthropicMessage(output, "user", [{
        type: "tool_result",
        tool_use_id: String(message.tool_call_id || ""),
        content: textContent(message.content),
      }]);
      continue;
    }
    const content = [];
    const text = textContent(message.content);
    if (text) content.push({ type: "text", text });
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const fn = call && call.function || {};
      let input = {};
      try {
        input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments || "{}") : fn.arguments || {};
      } catch {
        throw new Error(`Invalid tool arguments for ${fn.name || "unknown"}`);
      }
      content.push({ type: "tool_use", id: String(call.id || "tool_call"), name: String(fn.name || call.name || ""), input });
    }
    if (!content.length && message.content != null) content.push(...anthropicContent(message.content));
    pushAnthropicMessage(output, role === "assistant" ? "assistant" : "user", content);
  }
  if (output.length && output[0].role !== "user") {
    output.unshift({ role: "user", content: [{ type: "text", text: "(continued)" }] });
  }
  if (!output.length) throw new Error("messages must include user or assistant content");
  return output;
}

function toAnthropicTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const output = tools.map((tool) => {
    const fn = tool && tool.type === "function" ? tool.function : tool;
    if (!fn || !fn.name) throw new Error("tool name is required");
    return {
      name: String(fn.name),
      description: String(fn.description || ""),
      input_schema: fn.parameters || { type: "object", properties: {} },
    };
  });
  return output.length ? output : undefined;
}

function systemText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && message.role === "system")
    .map((message) => textContent(message.content))
    .filter(Boolean)
    .join("\n\n") || undefined;
}

function toAnthropicToolChoice(value) {
  if (!value || value === "auto") return value ? { type: "auto" } : undefined;
  if (value === "none") return { type: "none" };
  if (value === "required") return { type: "any" };
  if (typeof value === "object" && value.type === "function") {
    const name = String(value.function && value.function.name || "").trim();
    if (!name) throw new Error("tool_choice function name is required");
    return { type: "tool", name };
  }
  if (typeof value === "object" && ["auto", "any", "none", "tool"].includes(value.type)) return value;
  throw new Error("unsupported tool_choice format");
}

function toOpenAIResult(payload) {
  const blocks = Array.isArray(payload && payload.content) ? payload.content : [];
  const text = blocks.filter((block) => block && block.type === "text").map((block) => block.text || "").join("");
  const toolCalls = blocks.filter((block) => block && block.type === "tool_use").map((block) => ({
    id: String(block.id || "tool_call"),
    type: "function",
    function: { name: String(block.name || ""), arguments: JSON.stringify(block.input || {}) },
  }));
  const usage = payload && payload.usage || {};
  return {
    text,
    toolCalls,
    stopReason: payload && payload.stop_reason || (toolCalls.length ? "tool_use" : "end_turn"),
    usage: {
      inputTokens: Number(usage.input_tokens) || 0,
      outputTokens: Number(usage.output_tokens) || 0,
    },
  };
}

function parseSseEvent(raw) {
  const data = raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function readSse(response, onUpdate) {
  if (!response.body || typeof response.body.getReader !== "function") return toOpenAIResult(await response.json());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";
  const tools = new Map();
  const emit = () => onUpdate && onUpdate({ text, toolCalls: [...tools.values()], usage: { inputTokens, outputTokens } });
  const handle = (event) => {
    if (!event) return;
    if (event.type === "message_start") inputTokens = Number(event.message && event.message.usage && event.message.usage.input_tokens) || inputTokens;
    if (event.type === "content_block_start" && event.content_block && event.content_block.type === "tool_use") {
      tools.set(event.index, { id: String(event.content_block.id || `tool_${event.index}`), type: "function", function: { name: String(event.content_block.name || ""), arguments: "" } });
    }
    if (event.type === "content_block_delta" && event.delta) {
      if (event.delta.type === "text_delta") text += String(event.delta.text || "");
      if (event.delta.type === "input_json_delta") {
        const call = tools.get(event.index);
        if (call) call.function.arguments += String(event.delta.partial_json || "");
      }
    }
    if (event.type === "message_delta") {
      stopReason = event.delta && event.delta.stop_reason || stopReason;
      outputTokens = Number(event.usage && event.usage.output_tokens) || outputTokens;
    }
    emit();
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";
    for (const part of parts) handle(parseSseEvent(part));
    if (done) break;
  }
  if (buffer.trim()) handle(parseSseEvent(buffer));
  for (const call of tools.values()) {
    try { call.function.arguments = JSON.stringify(JSON.parse(call.function.arguments || "{}")); } catch { throw new Error(`Invalid streamed tool arguments for ${call.function.name}`); }
  }
  return { text, toolCalls: [...tools.values()], stopReason, usage: { inputTokens, outputTokens } };
}

function createDirectRelay(options = {}) {
  const baseURL = relayBaseUrl(options.baseURL);
  const token = String(options.token || "").trim() || loadRelayToken();
  const authScheme = options.authScheme || process.env.MIRASIM_RELAY_AUTH || "bearer";
  const defaultModel = String(options.model || process.env.MIRASIM_RELAY_MODEL || DEFAULT_MODEL).trim();
  const modelMap = options.modelMap && typeof options.modelMap === "object" ? options.modelMap : {};
  const clientVersion = String(options.clientVersion || process.env.MIRASIM_APP_VERSION || "0.0.149");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable in this Node runtime");

  function resolveModel(model) {
    const requested = String(model || "").trim();
    return String(modelMap[requested] || (requested === "mirasim-agent" ? defaultModel : requested || defaultModel));
  }

  function headers() {
    const output = { "content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION, "x-mirasim-client": clientVersion };
    if (authScheme === "x-api-key") output["x-api-key"] = token;
    else output.authorization = `Bearer ${token}`;
    return output;
  }

  async function complete(request = {}) {
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const body = {
      model: resolveModel(request.model),
      max_tokens: Number(request.max_tokens || request.maxOutputTokens || 8192),
      messages: toAnthropicMessages(messages),
      stream: request.stream === true,
    };
    const system = systemText(messages);
    if (system) body.system = system;
    const tools = toAnthropicTools(request.tools);
    if (tools) body.tools = tools;
    const toolChoice = toAnthropicToolChoice(request.tool_choice);
    if (toolChoice) body.tool_choice = toolChoice;
    if (Number.isFinite(Number(request.temperature))) body.temperature = Number(request.temperature);
    const response = await fetchImpl(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 1000);
      throw new Error(`MiraSim direct relay failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    if (request.stream) return readSse(response, request.onUpdate);
    return toOpenAIResult(await response.json());
  }

  return {
    baseURL,
    defaultModel,
    resolveModel,
    complete,
    health: async () => ({ ok: true, name: "mirasim-direct-relay", baseURL, model: defaultModel }),
  };
}

module.exports = {
  ANTHROPIC_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  createDirectRelay,
  loadRelayToken,
  toAnthropicMessages,
  toAnthropicToolChoice,
  toAnthropicTools,
  toOpenAIResult,
};

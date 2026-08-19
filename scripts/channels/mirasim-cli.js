#!/usr/bin/env node
"use strict";

/**
 * mirasim-cli 通道 · 本地 MiraSim server 经 mirachannel websocket 调用
 * ──────────────────────────────────────────────────────────────────────
 * 复用 scripts/mirasim-client.js 的 runTask, 把 OpenAI 请求归一成:
 *   prompt 桥 + 工具协议 (TOOL_BRIDGE_INSTRUCTION)
 * 由 MiraSim server 启动隔离 Claude worker → 走 MiraSim Cloud relay。
 *
 * 实现 Channel Contract (见 channels/index.js)。
 */

const path = require("node:path");
const mirasimClient = require(path.join(__dirname, "..", "mirasim-client.js"));

const TOOL_BRIDGE_INSTRUCTION = [
  "You are the model behind an external agent harness.",
  "Do not use tools, read or write files, run commands, or access the network yourself.",
  "The harness owns tool execution. When tools are available, return exactly one compact JSON object with one of these shapes:",
  '{"type":"final","content":"your answer"}',
  '{"type":"tool_call","tool_calls":[{"id":"call_id","name":"tool_name","arguments":{}}]}',
  "For a tool call, use only a tool name from the supplied tool definitions and make arguments a JSON object.",
  "After tool results are supplied, either request the next tool call or return type=final.",
  "Do not wrap the JSON in markdown fences or add commentary outside the JSON.",
].join("\n");

function contentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === "text" || part.type === "input_text") && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function toPrompt(body, tools = []) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    throw new Error("messages must be an array");
  }
  const lines = [];
  for (const message of body.messages) {
    if (!message || typeof message !== "object") continue;
    const role = ["system", "user", "assistant", "tool"].includes(message.role) ? message.role : "user";
    const content = contentText(message.content);
    const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length
      ? `\nTOOL_CALLS: ${JSON.stringify(message.tool_calls)}`
      : "";
    const toolCallId = message.tool_call_id ? `\nTOOL_CALL_ID: ${String(message.tool_call_id)}` : "";
    if (content || toolCalls || toolCallId) lines.push(`${role.toUpperCase()}: ${content}${toolCalls}${toolCallId}`);
  }
  const prompt = lines.join("\n\n").trim();
  if (!prompt) throw new Error("messages must include text content");
  if (prompt.length > 32_000) throw new Error("messages exceed 32000 characters after normalization");
  if (tools.length) {
    return `${TOOL_BRIDGE_INSTRUCTION}\n\nTOOL_DEFINITIONS:\n${JSON.stringify(tools)}\n\nCONVERSATION:\n${prompt}`;
  }
  return prompt;
}

function toolDefinitions(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => tool && tool.type === "function" ? tool.function : tool)
    .filter((tool) => tool && typeof tool.name === "string" && tool.name.trim())
    .map((tool) => ({ name: tool.name.trim(), description: String(tool.description || ""), parameters: tool.parameters || { type: "object", properties: {} } }));
}

function parseToolDecision(text, tools) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || "").trim());
  } catch {
    throw new Error("MiraSim tool bridge returned non-JSON output");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("MiraSim tool bridge returned an invalid decision");
  if (parsed.type === "final") {
    if (typeof parsed.content !== "string") throw new Error("MiraSim final decision content must be a string");
    return { type: "final", content: parsed.content };
  }
  if (parsed.type !== "tool_call" || !Array.isArray(parsed.tool_calls) || parsed.tool_calls.length < 1 || parsed.tool_calls.length > 32) {
    throw new Error("MiraSim tool bridge returned an invalid tool decision");
  }
  const allowed = new Set(toolDefinitions(tools).map((tool) => tool.name));
  const calls = parsed.tool_calls.map((call, index) => {
    const name = String(call && (call.name || call.function?.name) || "").trim();
    if (!allowed.has(name)) throw new Error(`MiraSim requested an undeclared tool: ${name || "<empty>"}`);
    const argumentsValue = call.arguments ?? call.function?.arguments ?? {};
    if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) throw new Error(`MiraSim arguments for ${name} must be a JSON object`);
    return { id: String(call.id || `call_${index}`), type: "function", function: { name, arguments: JSON.stringify(argumentsValue) } };
  });
  return { type: "tool_call", tool_calls: calls };
}

function createMirasimCliChannel(options = {}) {
  const client = options.client || mirasimClient;
  const model = String(options.model || process.env.MIRASIM_GATEWAY_MODEL || "mirasim-agent").trim();
  const baseUrl = options.baseUrl || process.env.MIRASIM_BASE_URL;

  async function health() {
    const status = await client.health({
      timeoutMs: 8000,
      ...(baseUrl ? { baseUrl } : {}),
    });
    return { ok: status.ok === true, name: "mirasim-cli", upstream: status.name || "mirasim", version: status.version || null, channelConfigured: status.channelConfigured === true };
  }

  async function complete(request, hooks = {}) {
    const tools = Array.isArray(request.tools) ? request.tools : [];
    const prompt = toPrompt({ messages: request.messages }, tools);
    const onUpdate = typeof hooks.onUpdate === "function" ? hooks.onUpdate : () => {};

    const snapshot = await client.runTask({ prompt, agent: request.agent }, {
      ...(baseUrl ? { url: baseUrl } : {}),
      onUpdate(update) {
        const text = String(update.text || "");
        if (text) onUpdate({ text });
      },
    });

    const latestText = String(snapshot && snapshot.text || "");
    let decision = { type: "final", content: latestText };
    if (tools.length) decision = parseToolDecision(latestText, tools);

    const usage = snapshot && snapshot.usage && typeof snapshot.usage === "object" ? snapshot.usage : {};
    return {
      text: decision.type === "final" ? decision.content : latestText,
      toolCalls: decision.type === "tool_call" ? decision.tool_calls : [],
      usage: {
        inputTokens: Number(usage.inputTokens || usage.contextTokens) || 0,
        outputTokens: Number(usage.outputTokens || usage.turnOutputTokens) || 0,
      },
    };
  }

  return { name: "mirasim-cli", model, health, complete };
}

module.exports = { createMirasimCliChannel, toPrompt, parseToolDecision, toolDefinitions };

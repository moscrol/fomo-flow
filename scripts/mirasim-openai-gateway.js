#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const mirasim = require("./mirasim-client.js");
const { createChannel } = require("./channels/index.js");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8977;
const DEFAULT_MODEL = "mirasim-agent";
const DEFAULT_TRANSPORT = "direct-relay";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function configPath() {
  return process.env.MIRASIM_GATEWAY_CONFIG || path.join(os.homedir(), ".mirasim-gateway", "config.json");
}

function loadConfig() {
  const file = configPath();
  try {
    if (!fs.existsSync(file)) return {};
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("must be a JSON object");
    return config;
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw new Error(`MiraSim gateway configuration unavailable: ${error.message}`);
  }
}

function keychainApiKey(service = "mirasim-openai-gateway") {
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

function createGateway(options = {}) {
  const key = String(options.apiKey || process.env.MIRASIM_GATEWAY_API_KEY || "").trim();
  if (!key) throw new Error("MIRASIM_GATEWAY_API_KEY is required");
  const client = options.client || mirasim;
  const model = String(options.model || process.env.MIRASIM_GATEWAY_MODEL || DEFAULT_MODEL).trim();
  const transport = String(options.transport || process.env.MIRASIM_GATEWAY_TRANSPORT || DEFAULT_TRANSPORT).trim().toLowerCase();
  if (!["direct-relay", "cli", "kiro"].includes(transport)) {
    throw new Error("MIRASIM_GATEWAY_TRANSPORT must be direct-relay, cli, or kiro");
  }

  // 统一通道抽象: 优先使用显式传入的 channel; 否则按 transport 从 channels/ 工厂解析。
  // channel 契约: { name, model, health(), complete(request, {onUpdate}) }
  const channel = options.channel || createChannel({
    transport,
    client,
    model,
    relay: options.relay,
    relayOptions: options.relayOptions,
    ...(options.kiroOptions || {}),
  });

  async function handler(req, res) {
    try {
      setCors(res);
      if (req.method === "OPTIONS") return res.writeHead(204).end();
      if (req.method === "GET" && req.url === "/health") {
        const status = await channel.health();
        return json(res, 200, { ok: true, gateway: "mirasim-openai", model, transport, channel: channel.name, mirasim: status });
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        if (!authorized(req, key)) return unauthorized(res);
        return json(res, 200, {
          object: "list",
          data: [{ id: model, object: "model", created: 0, owned_by: "mirasim" }],
        });
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        if (!authorized(req, key)) return unauthorized(res);
        const body = await readJson(req);
        const tools = normalizeTools(body);
        const requestModel = String(body.model || model).trim();
        if (requestModel !== model) return error(res, 400, "model_not_found", `Only ${model} is available`);
        return completion(res, channel, {
          ...body,
          model: requestModel,
          tools,
        });
      }
      return error(res, 404, "not_found", "Route not found");
    } catch (cause) {
      const status = cause && cause.code === "BODY_TOO_LARGE" ? 413 : 400;
      return error(res, status, "invalid_request_error", String((cause && cause.message) || cause));
    }
  }

  return http.createServer(handler);
}

function authorized(req, expected) {
  const header = String((req.headers && req.headers.authorization) || "");
  const xApiKey = String((req.headers && req.headers["x-api-key"]) || "");
  const given = header.replace(/^Bearer\s+/i, "").trim() || xApiKey.trim();
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

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

function toPrompt(body, options = {}) {
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
  if (options.tools && options.tools.length) {
    return `${TOOL_BRIDGE_INSTRUCTION}\n\nTOOL_DEFINITIONS:\n${JSON.stringify(options.tools)}\n\nCONVERSATION:\n${prompt}`;
  }
  return prompt;
}

function contentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === "text" || part.type === "input_text") && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function normalizeTools(body) {
  const tools = Array.isArray(body && body.tools) ? body.tools : [];
  const functions = Array.isArray(body && body.functions) ? body.functions : [];
  const normalized = tools.length
    ? tools
    : functions.map((fn) => ({ type: "function", function: fn }));
  if (normalized.length > 128) throw new Error("tools exceed 128 definitions");
  return normalized;
}

// 统一完成处理: 网关不关心上游是 CLI / relay / 未来任意通道,
// 只依赖 channel.complete(request, {onUpdate}) 契约。
function completion(res, channel, request) {
  const id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  let emittedText = "";
  let started = false;

  function streamChunk(delta, finishReason) {
    res.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: request.model,
      choices: [{ index: 0, delta, finish_reason: finishReason || null }],
    })}\n\n`);
  }

  if (request.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
  }

  return channel.complete(request, {
    onUpdate(update) {
      if (!request.stream) return;
      const text = String(update.text || "");
      if (text.startsWith(emittedText)) {
        const delta = text.slice(emittedText.length);
        if (delta) {
          if (!started) {
            streamChunk({ role: "assistant" });
            started = true;
          }
          emittedText = text;
          streamChunk({ content: delta });
        }
      }
    },
  }).then((result) => {
    const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
    const finishReason = toolCalls.length ? "tool_calls" : "stop";
    if (request.stream) {
      if (toolCalls.length) {
        streamChunk({ role: "assistant", tool_calls: toolCalls }, "tool_calls");
      } else if (String(result.text || "") !== emittedText) {
        if (!started) {
          streamChunk({ role: "assistant" });
          started = true;
        }
        streamChunk({ content: String(result.text || "").slice(emittedText.length) }, "stop");
      } else {
        streamChunk({}, finishReason);
      }
      res.end("data: [DONE]\n\n");
      return;
    }

    const message = toolCalls.length
      ? { role: "assistant", content: result.text || null, tool_calls: toolCalls }
      : { role: "assistant", content: String(result.text || "") };
    json(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: request.model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: usage(result),
    });
  }).catch((cause) => {
    if (request.stream) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/event-stream; charset=utf-8" });
      res.write(`data: ${JSON.stringify({ error: { message: String(cause.message || cause), type: "upstream_error" } })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    error(res, 502, "upstream_error", String(cause.message || cause));
  });
}

function usage(snapshot) {
  const data = snapshot && snapshot.usage && typeof snapshot.usage === "object" ? snapshot.usage : {};
  const completion = Number(data.turnOutputTokens || data.outputTokens) || 0;
  const prompt = Number(data.inputTokens || data.contextTokens) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function setCors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "Authorization, Content-Type, X-API-Key");
}

function json(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function error(res, status, type, message) {
  return json(res, status, { error: { message, type } });
}

function unauthorized(res) {
  res.setHeader("www-authenticate", 'Bearer realm="mirasim-gateway"');
  return error(res, 401, "authentication_error", "Invalid API key");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error("request body too large");
        error.code = "BODY_TOO_LARGE";
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("request body must be valid JSON"));
      }
    });
  });
}

async function start() {
  const config = loadConfig();
  const host = process.env.MIRASIM_GATEWAY_HOST || config.host || DEFAULT_HOST;
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("MIRASIM_GATEWAY_HOST must be a loopback address");
  }
  const port = Number(process.env.MIRASIM_GATEWAY_PORT || config.port) || DEFAULT_PORT;
  const model = process.env.MIRASIM_GATEWAY_MODEL || config.model || DEFAULT_MODEL;
  const transport = process.env.MIRASIM_GATEWAY_TRANSPORT || config.transport || DEFAULT_TRANSPORT;
  const apiKey = process.env.MIRASIM_GATEWAY_API_KEY || config.apiKey || keychainApiKey(config.keychainService);
  const relayOptions = {
    ...(config.relay || {}),
    ...(process.env.MIRASIM_RELAY_BASE_URL ? { baseURL: process.env.MIRASIM_RELAY_BASE_URL } : {}),
    ...(process.env.MIRASIM_RELAY_AUTH ? { authScheme: process.env.MIRASIM_RELAY_AUTH } : {}),
  };
  const kiroOptions = {
    ...(config.kiro || {}),
    ...(process.env.KIRO_CLI_PATH ? { cliPath: process.env.KIRO_CLI_PATH } : {}),
    ...(process.env.KIRO_CWD ? { cwd: process.env.KIRO_CWD } : {}),
  };
  const server = createGateway({ apiKey, model, transport, relayOptions, kiroOptions });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`MiraSim OpenAI gateway listening on http://${host}:${port}/v1`);
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { DEFAULT_HOST, DEFAULT_MODEL, DEFAULT_PORT, authorized, contentText, createGateway, loadConfig, toPrompt };

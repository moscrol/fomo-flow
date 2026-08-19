"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_BASE_URL = "http://127.0.0.1:4970";
const DEFAULT_TIMEOUT_MS = 15_000;

function settingsPath() {
  return process.env.MIRASIM_SETTINGS_PATH || path.join(os.homedir(), ".mirasim", "setting.json");
}

function loadToken() {
  if (process.env.MIRASIM_MIRACHANNEL_TOKEN) return process.env.MIRASIM_MIRACHANNEL_TOKEN;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch (error) {
    throw new Error(`MiraSim settings unavailable: ${error.message}`);
  }
  const token = String(parsed.mirachannelToken || "").trim();
  if (!token) throw new Error("MiraSim mirachannel token is not configured");
  return token;
}

function assertLoopback(parsed) {
  if (!["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) {
    throw new Error("MiraSim bridge only permits loopback endpoints");
  }
  return parsed;
}

function parseAbsoluteUrl(value, label) {
  try {
    return new URL(String(value || "").trim());
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
}

function baseUrl(value) {
  const parsed = parseAbsoluteUrl(value || process.env.MIRASIM_BASE_URL || DEFAULT_BASE_URL, "MIRASIM_BASE_URL");
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("MiraSim HTTP URL must use HTTP(S)");
  }
  return assertLoopback(parsed);
}

function toWebsocketUrl(value) {
  const parsed = parseAbsoluteUrl(value, "MiraSim channel URL");
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/mirachannel/ws";
    parsed.search = "";
  } else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("MiraSim channel URL must use HTTP(S) or WS(S)");
  }
  return assertLoopback(parsed).toString();
}

function socketUrl(value) {
  if (value) return toWebsocketUrl(value);
  const target = baseUrl();
  return toWebsocketUrl(target.toString());
}

function httpUrlFromOptions(options = {}) {
  if (options.baseUrl) return baseUrl(options.baseUrl);
  if (options.url) {
    const parsed = parseAbsoluteUrl(options.url, "MiraSim channel URL");
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    else if (parsed.protocol === "wss:") parsed.protocol = "https:";
    if (parsed.pathname === "/mirachannel/ws") parsed.pathname = "/";
    parsed.search = "";
    return assertLoopback(parsed);
  }
  return baseUrl();
}

function validatePrompt(value) {
  const prompt = String(value || "").trim();
  if (!prompt) throw new Error("prompt is required");
  if (prompt.length > 32_000) throw new Error("prompt exceeds 32000 characters");
  return prompt;
}

function validateSessionKey(value) {
  const sessionKey = String(value || "").trim();
  if (!sessionKey) throw new Error("sessionKey is required");
  if (sessionKey.length > 256) throw new Error("sessionKey is too long");
  return sessionKey;
}

function validateAgent(value) {
  const agent = String(value || "").trim();
  if (!agent) return undefined;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agent)) throw new Error("agent contains unsupported characters");
  return agent;
}

function redactSession(session) {
  if (!session || typeof session !== "object") return session;
  const output = {};
  for (const [key, value] of Object.entries(session)) {
    if (/token|secret|password|authorization|cookie/i.test(key)) continue;
    output[key] = value;
  }
  return output;
}

function defaultWebSocket(url) {
  if (typeof globalThis.WebSocket === "function") return new globalThis.WebSocket(url);
  try {
    const undici = require("undici");
    if (undici && typeof undici.WebSocket === "function") return new undici.WebSocket(url);
  } catch {}
  try {
    const WS = require("ws");
    if (typeof WS === "function") return new WS(url);
  } catch {}
  throw new Error("WebSocket is unavailable in this Node runtime");
}

function createSocket(url, factory) {
  if (factory) return factory(url);
  return defaultWebSocket(url);
}

function eventData(event) {
  if (event && typeof event === "object" && "data" in event) return event.data;
  return event;
}

function addListener(socket, name, listener) {
  if (typeof socket.addEventListener === "function") socket.addEventListener(name, listener);
  else socket[`on${name}`] = listener;
}

function runFrame(frame, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const token = options.token || loadToken();
  const url = socketUrl(options.url);
  const socket = createSocket(url, options.socketFactory);
  const expected = typeof options.accept === "function" ? options.accept : () => false;

  return new Promise((resolve, reject) => {
    let settled = false;
    let welcomed = false;
    const timer = setTimeout(() => finish(new Error("MiraSim channel timed out")), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      if (error) reject(error);
      else resolve(value);
    }

    addListener(socket, "open", () => {
      try {
        socket.send(JSON.stringify({
          type: "hello",
          v: 1,
          token,
          client: { name: "dao-flow-devin-bridge", platform: `node/${process.version}` },
        }));
      } catch (error) {
        finish(error);
      }
    });

    addListener(socket, "message", (event) => {
      if (settled) return;
      let message;
      try {
        message = JSON.parse(String(eventData(event)));
      } catch {
        return;
      }
      if (message.type === "error") {
        finish(new Error(message.message || message.code || "MiraSim channel error"));
        return;
      }
      if (message.type === "welcome") {
        welcomed = true;
        try {
          socket.send(JSON.stringify(frame));
        } catch (error) {
          finish(error);
        }
        return;
      }
      if (welcomed && expected(message)) finish(null, redactSession(message));
    });

    addListener(socket, "error", () => finish(new Error("MiraSim channel connection failed")));
    addListener(socket, "close", () => {
      if (!settled) finish(new Error("MiraSim channel closed before a response"));
    });
  });
}

async function health(options = {}) {
  const target = httpUrlFromOptions(options);
  const url = new URL("/api/health", target).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(Number(options.timeoutMs) || 5_000) });
  if (!response.ok) throw new Error(`MiraSim health check failed: HTTP ${response.status}`);
  const payload = await response.json();
  return {
    ok: payload.ok === true,
    name: payload.name || "mirasim",
    version: payload.version || null,
    uptime: Number(payload.uptime) || 0,
    channelConfigured: !!loadToken(),
  };
}

function submitTask(args, options = {}) {
  const clientRef = crypto.randomUUID();
  const frame = {
    type: "prompt",
    clientRef,
    prompt: validatePrompt(args && args.prompt),
  };
  const sessionKey = String((args && args.sessionKey) || "").trim();
  if (sessionKey) frame.sessionKey = validateSessionKey(sessionKey);
  const agent = validateAgent(args && args.agent);
  if (agent) frame.agent = agent;
  return runFrame(frame, {
    ...options,
    accept: (message) => message.type === "accepted" && (!message.clientRef || message.clientRef === clientRef),
  });
}

function listSessions(options = {}) {
  return runFrame({ type: "listSessions" }, {
    ...options,
    accept: (message) => message.type === "sessions",
  }).then((message) => ({ sessions: Array.isArray(message.sessions) ? message.sessions.map(redactSession) : [] }));
}

function getSession(args, options = {}) {
  const sessionKey = validateSessionKey(args && args.sessionKey);
  return runFrame({ type: "getSnapshot", sessionKey }, {
    ...options,
    accept: (message) => message.type === "session" && message.sessionKey === sessionKey,
  });
}

function stopSession(args, options = {}) {
  const sessionKey = validateSessionKey(args && args.sessionKey);
  return runFrame({ type: "stop", sessionKey }, {
    ...options,
    accept: (message) => message.type === "accepted" && message.sessionKey === sessionKey,
  }).catch((error) => {
    if (/timed out|closed before/i.test(error.message)) return { ok: true, sessionKey, delivery: "sent_without_ack" };
    throw error;
  });
}

function applyPatch(previous, patch) {
  if (patch && patch.full) return patch.full;
  const next = Object.assign({}, previous || { phase: "idle", updatedAt: 0 });
  if (!patch || typeof patch !== "object") return next;
  if (typeof patch.appendText === "string") next.text = String(next.text || "") + patch.appendText;
  if (typeof patch.appendReasoning === "string") next.reasoning = String(next.reasoning || "") + patch.appendReasoning;
  if (patch.set && typeof patch.set === "object") Object.assign(next, patch.set);
  return next;
}

function isTerminalPhase(phase) {
  return new Set(["completed", "done", "failed", "cancelled", "canceled", "stopped", "error"]).has(String(phase || "").toLowerCase());
}

function runTask(args, options = {}) {
  const prompt = validatePrompt(args && args.prompt);
  const clientRef = crypto.randomUUID();
  const token = options.token || loadToken();
  const url = socketUrl(options.url);
  const timeoutMs = Number(options.timeoutMs) || 10 * 60_000;
  const socket = createSocket(url, options.socketFactory);
  const agent = validateAgent(args && args.agent);
  const requestedSessionKey = String((args && args.sessionKey) || "").trim();
  const frame = { type: "prompt", clientRef, prompt };
  if (requestedSessionKey) frame.sessionKey = validateSessionKey(requestedSessionKey);
  if (agent) frame.agent = agent;

  return new Promise((resolve, reject) => {
    let settled = false;
    let sessionKey = "";
    let snapshot = null;
    const timer = setTimeout(() => finish(new Error("MiraSim task timed out")), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      if (error) reject(error);
      else resolve(value);
    }

    addListener(socket, "open", () => {
      try {
        socket.send(JSON.stringify({
          type: "hello",
          v: 1,
          token,
          client: { name: "mirasim-openai-gateway", platform: `node/${process.version}` },
        }));
      } catch (error) {
        finish(error);
      }
    });

    addListener(socket, "message", (event) => {
      if (settled) return;
      let message;
      try {
        message = JSON.parse(String(eventData(event)));
      } catch {
        return;
      }
      if (message.type === "error") {
        finish(new Error(message.message || message.code || "MiraSim channel error"));
        return;
      }
      if (message.type === "welcome") {
        try {
          socket.send(JSON.stringify(frame));
        } catch (error) {
          finish(error);
        }
        return;
      }
      if (message.type === "accepted" && (!message.clientRef || message.clientRef === clientRef)) {
        sessionKey = validateSessionKey(message.sessionKey);
        try {
          socket.send(JSON.stringify({ type: "subscribe", sessionKey }));
          socket.send(JSON.stringify({ type: "getSnapshot", sessionKey }));
        } catch (error) {
          finish(error);
        }
        return;
      }
      if (message.type !== "session" || !sessionKey || message.sessionKey !== sessionKey) return;
      snapshot = applyPatch(snapshot, message.patch);
      const safeSnapshot = redactSession(Object.assign({ sessionKey }, snapshot));
      if (typeof options.onUpdate === "function") options.onUpdate(safeSnapshot);
      if (isTerminalPhase(safeSnapshot.phase)) {
        if (safeSnapshot.error) finish(new Error(String(safeSnapshot.error)));
        else finish(null, safeSnapshot);
      }
    });

    addListener(socket, "error", () => finish(new Error("MiraSim channel connection failed")));
    addListener(socket, "close", () => {
      if (!settled) finish(new Error("MiraSim channel closed before task completion"));
    });
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  applyPatch,
  baseUrl,
  health,
  httpUrlFromOptions,
  isTerminalPhase,
  listSessions,
  getSession,
  loadToken,
  runFrame,
  runTask,
  socketUrl,
  stopSession,
  submitTask,
  toWebsocketUrl,
};

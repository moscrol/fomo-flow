"use strict";

const { createWebHudSnapshot } = require("./web_hud_projection.js");
const { buildObservabilityFromHudInputs } = require("./observability_store.js");

const DEFAULT_CADENCE_MS = 2_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_CLIENTS = 8;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function stableSignature(snapshot) {
  return JSON.stringify(snapshot, (key, value) => {
    if (
      key === "generatedAt" ||
      key === "freshnessMs" ||
      key === "ageMs" ||
      key === "remainingMs"
    ) return 0;
    return value;
  });
}

function createWebHudService(options = {}) {
  const readers = options.readers && typeof options.readers === "object"
    ? options.readers
    : {};
  const readInputs = typeof options.readInputs === "function"
    ? options.readInputs
    : null;
  const project = typeof options.project === "function"
    ? options.project
    : createWebHudSnapshot;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setIntervalFn = typeof options.setInterval === "function"
    ? options.setInterval
    : setInterval;
  const clearIntervalFn = typeof options.clearInterval === "function"
    ? options.clearInterval
    : clearInterval;
  const cadenceMs = positiveInteger(options.cadenceMs, DEFAULT_CADENCE_MS);
  const heartbeatMs = positiveInteger(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  const maxClients = positiveInteger(options.maxClients, DEFAULT_MAX_CLIENTS);

  const clients = new Map();
  let nextClientId = 1;
  let timer = null;
  let disposed = false;
  let lastSnapshot = null;
  let lastSignature = "";
  let lastWriteAt = 0;

  function safeRead(name, fallback, source, warnings) {
    try {
      if (typeof readers[name] === "function") return readers[name]();
      if (source && Object.prototype.hasOwnProperty.call(source, name)) {
        return source[name];
      }
    } catch {
      warnings.push(`${name} unavailable`);
      return fallback;
    }
    return fallback;
  }

  function buildSnapshot() {
    const input = { componentWarnings: [] };
    let combined = null;
    if (readInputs) {
      try {
        const value = readInputs();
        combined = value && typeof value === "object" ? value : {};
      } catch {
        input.componentWarnings.push("runtime inputs unavailable");
        combined = {};
      }
    }
    input.now = now();
    input.runtime = safeRead("runtime", { healthy: false }, combined || input, input.componentWarnings);
    input.agentSummaries = safeRead("agentSummaries", [], combined || input, input.componentWarnings);
    input.codexSummaries = safeRead("codexSummaries", [], combined || input, input.componentWarnings);
    input.codexHealth = safeRead("codexHealth", { state: "off" }, combined || input, input.componentWarnings);
    input.codexRoute = safeRead("codexRoute", {}, combined || input, input.componentWarnings);
    input.routerStatus = safeRead("routerStatus", {}, combined || input, input.componentWarnings);
    input.usage = safeRead("usage", {}, combined || input, input.componentWarnings);
    input.tasks = safeRead("tasks", [], combined || input, input.componentWarnings);
    // Observability: prefer injected reader; else derive from usage + codex summaries
    // on the read path (never mutates global router counters).
    try {
      if (typeof readers.observability === "function") {
        input.observability = readers.observability({
          usage: input.usage,
          codexSummaries: input.codexSummaries,
          codexRoute: input.codexRoute,
          codexHealth: input.codexHealth,
          now: input.now,
        });
      } else if (
        combined &&
        Object.prototype.hasOwnProperty.call(combined, "observability")
      ) {
        input.observability = combined.observability;
      } else {
        input.observability = buildObservabilityFromHudInputs({
          usage: input.usage,
          codexSummaries: input.codexSummaries,
          codexRoute: input.codexRoute,
          now: input.now,
        });
      }
    } catch {
      input.componentWarnings.push("observability unavailable");
      input.observability = null;
    }
    try {
      return project(input);
    } catch {
      return createWebHudSnapshot({
        now: input.now,
        runtime: { healthy: false },
        componentWarnings: [...input.componentWarnings, "projection unavailable"],
      });
    }
  }

  function snapshot() {
    const candidate = buildSnapshot();
    lastSnapshot = candidate;
    lastSignature = stableSignature(candidate);
    return candidate;
  }

  function frame(candidate) {
    return `event: snapshot\ndata: ${JSON.stringify(candidate)}\n\n`;
  }

  function removeClient(id) {
    const client = clients.get(id);
    if (!client) return;
    clients.delete(id);
    if (client.response && typeof client.response.removeListener === "function") {
      client.response.removeListener("close", client.onClose);
      client.response.removeListener("error", client.onClose);
    }
    if (clients.size === 0 && timer) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  function writeClient(client, chunk) {
    if (!client || !client.response || client.response.writableEnded || client.response.destroyed) {
      removeClient(client && client.id);
      return false;
    }
    try {
      client.response.write(chunk);
      return true;
    } catch {
      removeClient(client.id);
      return false;
    }
  }

  function broadcast(chunk) {
    for (const client of [...clients.values()]) writeClient(client, chunk);
  }

  function tick() {
    if (disposed || clients.size === 0) return;
    const current = buildSnapshot();
    const signature = stableSignature(current);
    const timestamp = Number(now()) || Date.now();
    if (signature !== lastSignature) {
      lastSnapshot = current;
      lastSignature = signature;
      lastWriteAt = timestamp;
      broadcast(frame(current));
      return;
    }
    if (timestamp - lastWriteAt >= heartbeatMs) {
      lastWriteAt = timestamp;
      broadcast(`: heartbeat ${timestamp}\n\n`);
    }
  }

  function startTimer() {
    if (timer || disposed || clients.size === 0) return;
    timer = setIntervalFn(tick, cadenceMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function subscribe(response) {
    if (disposed) return { ok: false, reason: "disposed" };
    if (!response || typeof response.write !== "function") {
      return { ok: false, reason: "invalid-response" };
    }
    if (clients.size >= maxClients) return { ok: false, reason: "client-limit" };

    const id = nextClientId++;
    const onClose = () => removeClient(id);
    const client = { id, response, onClose };
    clients.set(id, client);
    if (typeof response.once === "function") {
      response.once("close", onClose);
      response.once("error", onClose);
    }

    const current = buildSnapshot();
    lastSnapshot = current;
    lastSignature = stableSignature(current);
    if (!lastWriteAt) lastWriteAt = Number(now()) || Date.now();
    writeClient(client, frame(current));
    if (!clients.has(id)) return { ok: false, reason: "write-failed" };
    startTimer();

    let subscriptionDisposed = false;
    return {
      ok: true,
      dispose() {
        if (subscriptionDisposed) return;
        subscriptionDisposed = true;
        removeClient(id);
      },
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const id of [...clients.keys()]) removeClient(id);
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    lastSnapshot = null;
    lastSignature = "";
  }

  return {
    snapshot,
    subscribe,
    dispose,
    clientCount: () => clients.size,
  };
}

module.exports = {
  createWebHudService,
};

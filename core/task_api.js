"use strict";

const { isLoopbackAddress } = require("./web_hud_http.js");

const MAX_BODY_BYTES = 64 * 1024;

function json(response, status, value) {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function requestPath(request) {
  try {
    return new URL(request.url || "/", "http://localhost").pathname;
  } catch (_) {
    return "";
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        fail(Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_) {
        reject(Object.assign(new Error("invalid JSON body"), { code: "INVALID_JSON" }));
      }
    });
    request.on("error", fail);
  });
}

function resultStatus(result) {
  if (!result || result.ok !== false) return 200;
  if (result.reason === "not-found") return 404;
  if (result.reason === "already-exists" || result.reason === "terminal") return 409;
  return 400;
}

function taskRoute(pathname) {
  const match = pathname.match(/^\/origin\/tasks(?:\/([^/]+))?(?:\/(start|heartbeat|result|transport-lost|attempts))?$/);
  if (!match) return null;
  return {
    jobId: match[1] ? decodeURIComponent(match[1]) : "",
    action: match[2] || "",
  };
}

function createTaskApiHandler(options = {}) {
  const store = options.store;
  const isLocal = typeof options.isLocal === "function"
    ? options.isLocal
    : (request) => isLoopbackAddress(request.socket && request.socket.remoteAddress);
  const authOk = typeof options.authOk === "function" ? options.authOk : () => false;
  const loadConfig = typeof options.loadConfig === "function" ? options.loadConfig : () => ({});

  return async function handleTaskApi(request, response) {
    const pathname = requestPath(request);
    const route = taskRoute(pathname);
    if (!route) return false;
    if (!store) {
      json(response, 503, { ok: false, error: "task store unavailable" });
      return true;
    }
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("Allow", "GET, POST, OPTIONS");
      response.end();
      return true;
    }
    const local = isLocal(request);
    let authorized = false;
    try {
      authorized = local && authOk(request, loadConfig());
    } catch (_) {}
    if (!authorized) {
      json(response, local ? 401 : 403, {
        ok: false,
        error: local ? "task API requires local Dao bearer key" : "task API is localhost only",
      });
      return true;
    }
    if (request.method === "GET") {
      if (route.action) {
        json(response, 405, { ok: false, error: "method not allowed" });
        return true;
      }
      if (!route.jobId) {
        json(response, 200, { ok: true, tasks: store.list() });
        return true;
      }
      const task = store.get(route.jobId);
      if (!task) {
        json(response, 404, { ok: false, error: "task not found" });
        return true;
      }
      json(response, 200, { ok: true, task });
      return true;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "GET, POST, OPTIONS");
      json(response, 405, { ok: false, error: "method not allowed" });
      return true;
    }

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      json(response, error && error.code === "BODY_TOO_LARGE" ? 413 : 400, {
        ok: false,
        error: error && error.code === "BODY_TOO_LARGE" ? "request body too large" : "invalid JSON body",
      });
      return true;
    }

    let result;
    if (!route.jobId && !route.action) {
      result = store.create(body);
      json(response, resultStatus(result) === 200 ? 201 : resultStatus(result), result);
      return true;
    }
    if (!route.jobId || !route.action) {
      json(response, 404, { ok: false, error: "unknown task endpoint" });
      return true;
    }
    if (route.action === "start") result = store.start(route.jobId, body);
    else if (route.action === "heartbeat") result = store.heartbeat(route.jobId, body);
    else if (route.action === "result") result = store.result(route.jobId, body);
    else if (route.action === "transport-lost") result = store.markTransportLost(route.jobId, body);
    else if (route.action === "attempts") result = store.addAttempt(route.jobId, body);
    else result = { ok: false, reason: "unknown-endpoint" };
    json(response, resultStatus(result), result);
    return true;
  };
}

module.exports = {
  MAX_BODY_BYTES,
  createTaskApiHandler,
  taskRoute,
};

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  // The desktop renderer embeds the loopback HUD in a sandboxed iframe whose
  // parent is the packaged file-origin React shell. Keep browser framing
  // blocked while allowing that explicit local app origin.
  "frame-ancestors 'self' file:",
].join("; ");

const ASSETS = Object.freeze({
  "/hud": { file: "web-hud.html", type: "text/html; charset=utf-8" },
  "/hud/": { file: "web-hud.html", type: "text/html; charset=utf-8" },
  "/hud/web-hud.css": { file: "web-hud.css", type: "text/css; charset=utf-8" },
  "/hud/web-hud.js": { file: "web-hud.js", type: "text/javascript; charset=utf-8" },
});

function isLoopbackAddress(value) {
  const address = String(value || "").toLowerCase();
  return address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1";
}

function isHudPath(pathname) {
  return pathname === "/origin/hud/snapshot" ||
    pathname === "/origin/hud/events" ||
    pathname === "/hud" ||
    pathname === "/hud/" ||
    pathname.startsWith("/hud/");
}

function securityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", CSP);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function json(response, status, value) {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function createWebHudHttpHandler(options = {}) {
  const service = options.service;
  const assetDir = path.resolve(String(options.assetDir || ""));
  const readFile = typeof options.readFile === "function"
    ? options.readFile
    : fs.readFile.bind(fs);

  return function handleWebHud(request, response) {
    let pathname = "";
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      return false;
    }
    if (!isHudPath(pathname)) return false;

    try {
      securityHeaders(response);
      const remoteAddress = request.socket && request.socket.remoteAddress;
      if (!isLoopbackAddress(remoteAddress)) {
        json(response, 403, { ok: false, error: "localhost only" });
        return true;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        json(response, 405, { ok: false, error: "method not allowed" });
        return true;
      }

      if (pathname === "/origin/hud/snapshot") {
        if (!service || typeof service.snapshot !== "function") {
          json(response, 503, { ok: false, error: "hud unavailable" });
          return true;
        }
        try {
          json(response, 200, service.snapshot());
        } catch {
          json(response, 500, { ok: false, error: "hud snapshot unavailable" });
        }
        return true;
      }

      if (pathname === "/origin/hud/events") {
        if (!service || typeof service.subscribe !== "function") {
          json(response, 503, { ok: false, error: "hud unavailable" });
          return true;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        response.setHeader("X-Accel-Buffering", "no");
        if (request.httpVersionMajor !== 2) {
          response.setHeader("Connection", "keep-alive");
        }
        const subscription = service.subscribe(response);
        if (!subscription || subscription.ok !== true) {
          json(response, subscription && subscription.reason === "client-limit" ? 429 : 503, {
            ok: false,
            error: subscription && subscription.reason === "client-limit"
              ? "too many hud clients"
              : "hud stream unavailable",
          });
        }
        return true;
      }

      const asset = ASSETS[pathname];
      if (!asset) {
        json(response, 404, { ok: false, error: "hud asset not found" });
        return true;
      }
      const filename = path.join(assetDir, asset.file);
      readFile(filename, (error, body) => {
        if (response.writableEnded) return;
        if (error || !Buffer.isBuffer(body)) {
          json(response, 404, { ok: false, error: "hud asset unavailable" });
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", asset.type);
        response.setHeader("Content-Length", String(body.length));
        response.end(body);
      });
      return true;
    } catch {
      try {
        json(response, 500, { ok: false, error: "hud request unavailable" });
      } catch {}
      return true;
    }
  };
}

module.exports = {
  createWebHudHttpHandler,
  isLoopbackAddress,
};

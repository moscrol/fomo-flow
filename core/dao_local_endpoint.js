"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");

const DEFAULT_TIMEOUT_MS = 450;
const MAX_HEALTH_BYTES = 8 * 1024;

function normalizeLoopbackBase(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "/" && parsed.pathname !== "") ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      return null;
    }
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

function parseLoopbackEndpointDescriptor(value) {
  let descriptor = value;
  if (typeof descriptor === "string") {
    try {
      descriptor = JSON.parse(descriptor);
    } catch {
      return null;
    }
  }
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor)
  )
    return null;
  const base = normalizeLoopbackBase(descriptor.base);
  if (!base || descriptor.host !== "127.0.0.1") return null;
  const parsed = new URL(base);
  if (Number(descriptor.port) !== Number(parsed.port)) return null;
  return base;
}

async function probeDaoEndpoint(
  base,
  { timeoutMs = DEFAULT_TIMEOUT_MS, request = http.get } = {},
) {
  const normalized = normalizeLoopbackBase(base);
  if (!normalized) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const req = request(
        `${normalized}/origin/health`,
        { timeout: timeoutMs },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            finish(false);
            return;
          }
          let size = 0;
          const chunks = [];
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_HEALTH_BYTES) {
              req.destroy();
              finish(false);
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            try {
              const payload = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              );
              const port = Number(new URL(normalized).port);
              finish(
                payload &&
                  payload.ok === true &&
                  payload.dao_loaded === true &&
                  Number(payload.port) === port,
              );
            } catch {
              finish(false);
            }
          });
          res.on("error", () => finish(false));
        },
      );
      req.on("timeout", () => {
        req.destroy();
        finish(false);
      });
      req.on("error", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function selectDaoEndpoint({
  explicitUrl = "",
  desktopDescriptorPath = "",
  inheritedUrl = "",
  fallbackUrl = "http://127.0.0.1:8937",
  readFile = (filePath) => fs.readFile(filePath, "utf8"),
  probe = probeDaoEndpoint,
} = {}) {
  const candidates = [];
  const add = (value) => {
    const normalized = normalizeLoopbackBase(value);
    if (normalized && !candidates.includes(normalized))
      candidates.push(normalized);
  };
  add(explicitUrl);
  if (!explicitUrl && desktopDescriptorPath) {
    try {
      const raw = await readFile(desktopDescriptorPath);
      add(parseLoopbackEndpointDescriptor(raw));
    } catch {}
  }
  add(inheritedUrl);
  add(fallbackUrl);
  for (const candidate of candidates) {
    if (await probe(candidate)) return candidate;
  }
  return "";
}

module.exports = {
  normalizeLoopbackBase,
  parseLoopbackEndpointDescriptor,
  probeDaoEndpoint,
  selectDaoEndpoint,
};

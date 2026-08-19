"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cachePath(env = process.env, home = os.homedir()) {
  if (env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, "devin", "cli", "team_settings.bin");
  }
  return path.join(home, ".local", "share", "devin", "cli", "team_settings.bin");
}

function readFresh(filePath, options = {}) {
  try {
    const stat = fs.statSync(filePath);
    const now = options.now == null ? Date.now() : options.now;
    const maxAgeMs = options.maxAgeMs == null ? MAX_AGE_MS : options.maxAgeMs;
    const age = now - stat.mtimeMs;
    if (!stat.isFile() || stat.size < 2 || stat.size > 2 * 1024 * 1024) return null;
    if (age > maxAgeMs) return null;
    const body = fs.readFileSync(filePath);
    if (!body.length || body[0] === 0) return null;
    return body;
  } catch (_) {
    return null;
  }
}

module.exports = { MAX_AGE_MS, cachePath, readFresh };

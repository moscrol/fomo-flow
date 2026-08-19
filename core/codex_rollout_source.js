"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCodexTelemetryStore } = require("./codex_telemetry.js");
const { stateFile } = require("./product_identity");

const MAX_FILES = 64;
const MAX_READ_BYTES = 16 * 1024 * 1024;

function pathHash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex")
    .slice(0, 24);
}

function readCheckpoints(target) {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeCheckpoints(target, checkpoints) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(checkpoints, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
}

function dateDirectories(root, nowValue) {
  return [new Date(nowValue), new Date(nowValue - 86_400_000)].map((date) =>
    path.join(
      root,
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ),
  );
}

function discoverRecentRollouts(root, nowValue = Date.now(), limit = MAX_FILES) {
  const files = [];
  for (const directory of dateDirectories(root, nowValue)) {
    let names = [];
    try {
      names = fs.readdirSync(directory);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!/^rollout-.+\.jsonl$/.test(name)) continue;
      const file = path.join(directory, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) files.push({ file, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  }
  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((item) => item.file);
}

function createCodexRolloutSource(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const store = options.store || createCodexTelemetryStore({ now });
  const sessionsRoot = options.sessionsRoot || path.join(os.homedir(), ".codex", "sessions");
  const checkpointPath = options.checkpointPath ||
    stateFile("codex-rollout-checkpoints.json") ||
    path.join(os.homedir(), ".fomo-flow", "codex-rollout-checkpoints.json");
  const pollMs = Math.max(500, Number(options.pollMs) || 2_000);
  const checkpointState = readCheckpoints(checkpointPath);
  const checkpoints = checkpointState.files && typeof checkpointState.files === "object"
    ? checkpointState.files
    : {};
  let timer = null;

  for (const [sourceId, checkpoint] of Object.entries(checkpoints)) {
    if (checkpoint && checkpoint.summary) store.hydrate(sourceId, checkpoint.summary);
  }

  function tailOneFile(file) {
    const stat = fs.statSync(file);
    const sourceId = pathHash(file);
    const previous = checkpoints[sourceId] || {
      offset: 0,
      dev: stat.dev,
      ino: stat.ino,
    };
    const previousOffset = Math.max(0, Number(previous.offset) || 0);
    const reset = previous.dev !== stat.dev ||
      previous.ino !== stat.ino ||
      stat.size < previousOffset;
    const offset = reset ? 0 : previousOffset;
    if (stat.size === offset) return;

    const length = Math.min(stat.size - offset, MAX_READ_BYTES);
    const buffer = Buffer.alloc(length);
    const descriptor = fs.openSync(file, "r");
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
    } finally {
      fs.closeSync(descriptor);
    }
    const chunk = buffer.subarray(0, bytesRead);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return;

    const processedLength = lastNewline + 1;
    const lines = chunk.subarray(0, processedLength).toString("utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        store.ingest(JSON.parse(line), sourceId);
      } catch {
        store.ingest(null, sourceId);
      }
    }
    checkpoints[sourceId] = {
      offset: offset + processedLength,
      dev: stat.dev,
      ino: stat.ino,
      updatedAt: now(),
      summary: store.summaryForSource(sourceId),
    };
  }

  function poll() {
    const clock = now();
    const files = discoverRecentRollouts(sessionsRoot, clock, MAX_FILES).reverse();
    for (const file of files) {
      try {
        tailOneFile(file);
      } catch {
        store.ingest(null, pathHash(file));
      }
    }
    writeCheckpoints(checkpointPath, { version: 1, files: checkpoints });
    return store.snapshot();
  }

  function start() {
    if (timer) return;
    try {
      poll();
    } catch {
      store.ingest(null, "poll");
    }
    timer = setInterval(() => {
      try {
        poll();
      } catch {
        store.ingest(null, "poll");
      }
    }, pollMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  if (options.autoStart !== false) start();
  return {
    poll,
    start,
    dispose,
    list: store.list,
    health: () => store.snapshot().health,
  };
}

module.exports = {
  createCodexRolloutSource,
  discoverRecentRollouts,
};

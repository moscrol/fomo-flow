"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_INLINE_CHARS = 8000;
const PREVIEW_HEAD_CHARS = 1400;
const PREVIEW_TAIL_CHARS = 600;
const DEFAULT_READ_CHARS = 12000;
const MAX_READ_CHARS = 24000;
const MAX_FILES = 512;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PRESERVE_RECENT_TOOL_RESULTS = 4;

let storeDir = null;
let log = () => {};
let writesSinceCleanup = 0;
const stats = {
  stored: 0,
  reused: 0,
  compactedMessages: 0,
  compactedChars: 0,
  preservedRecentMessages: 0,
  reads: 0,
  readChars: 0,
};

function init(opts = {}) {
  log = typeof opts.log === "function" ? opts.log : () => {};
  storeDir = opts.dir ? path.resolve(opts.dir) : null;
  if (!storeDir) return;
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    _cleanup();
  } catch (error) {
    storeDir = null;
    log(`[tool-output-store] init failed: ${error.message}`);
  }
}

function _idFor(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32);
}

function _pathFor(outputId) {
  if (!storeDir || !/^[a-f0-9]{32}$/.test(String(outputId || ""))) return null;
  return path.join(storeDir, `${outputId}.txt`);
}

function _write(outputId, content) {
  const filePath = _pathFor(outputId);
  if (!filePath) return false;
  if (fs.existsSync(filePath)) {
    stats.reused++;
    return true;
  }
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, "utf8");
    try {
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      if (!fs.existsSync(filePath)) throw error;
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
    stats.stored++;
    writesSinceCleanup++;
    if (writesSinceCleanup >= 32) {
      writesSinceCleanup = 0;
      _cleanup();
    }
    return true;
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
    log(`[tool-output-store] write failed: ${error.message}`);
    return false;
  }
}

function _preview(content) {
  if (content.length <= PREVIEW_HEAD_CHARS + PREVIEW_TAIL_CHARS) return content;
  return `${content.slice(0, PREVIEW_HEAD_CHARS)}\n... [middle omitted; full output stored locally] ...\n${content.slice(-PREVIEW_TAIL_CHARS)}`;
}

function _compactContent(content) {
  if (!storeDir || typeof content !== "string" || content.length <= MAX_INLINE_CHARS)
    return null;
  const outputId = _idFor(content);
  if (!_write(outputId, content)) return null;
  return {
    outputId,
    replacement: [
      `[Large tool output stored as dao-output://${outputId}]`,
      `Original characters: ${content.length}. The complete output remains available locally.`,
      `Use dao_read_tool_output with output_id="${outputId}" and an optional offset to read it in chunks.`,
      "",
      _preview(content),
    ].join("\n"),
  };
}

function compactMessages(messages, opts = {}) {
  if (!Array.isArray(messages) || !storeDir) {
    return {
      messages: Array.isArray(messages) ? messages : [],
      compacted: 0,
      savedChars: 0,
      preservedRecent: 0,
    };
  }
  const preserveRecentToolResults = Math.max(
    0,
    Number.isFinite(Number(opts.preserveRecentToolResults))
      ? Math.floor(Number(opts.preserveRecentToolResults))
      : DEFAULT_PRESERVE_RECENT_TOOL_RESULTS,
  );
  const recentIndexes = new Set();
  for (
    let index = messages.length - 1;
    index >= 0 && recentIndexes.size < preserveRecentToolResults;
    index--
  ) {
    const message = messages[index];
    if (message && message.role === "tool" && typeof message.content === "string") {
      recentIndexes.add(index);
    }
  }
  let compacted = 0;
  let savedChars = 0;
  let preservedRecent = 0;
  const output = messages.map((message, index) => {
    if (!message || message.role !== "tool" || typeof message.content !== "string")
      return message;
    if (recentIndexes.has(index)) {
      preservedRecent++;
      return message;
    }
    const result = _compactContent(message.content);
    if (!result) return message;
    compacted++;
    savedChars += Math.max(0, message.content.length - result.replacement.length);
    return { ...message, content: result.replacement };
  });
  stats.compactedMessages += compacted;
  stats.compactedChars += savedChars;
  stats.preservedRecentMessages += preservedRecent;
  return { messages: output, compacted, savedChars, preservedRecent };
}

function read(outputId, offset, maxChars) {
  const filePath = _pathFor(outputId);
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: "tool output not found or expired", outputId };
  }
  const start = Math.max(0, Number(offset) || 0);
  const limit = Math.min(
    MAX_READ_CHARS,
    Math.max(1000, Number(maxChars) || DEFAULT_READ_CHARS),
  );
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const chunk = content.slice(start, start + limit);
    stats.reads++;
    stats.readChars += chunk.length;
    return {
      ok: true,
      outputId,
      offset: start,
      nextOffset: start + chunk.length,
      totalChars: content.length,
      hasMore: start + chunk.length < content.length,
      content: chunk,
    };
  } catch (error) {
    return { ok: false, error: error.message, outputId };
  }
}

function _cleanup() {
  if (!storeDir || !fs.existsSync(storeDir)) return;
  let entries;
  try {
    entries = fs
      .readdirSync(storeDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{32}\.txt$/.test(entry.name))
      .map((entry) => {
        const filePath = path.join(storeDir, entry.name);
        const stat = fs.statSync(filePath);
        return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch (error) {
    log(`[tool-output-store] cleanup scan failed: ${error.message}`);
    return;
  }
  const now = Date.now();
  let totalBytes = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    totalBytes += entry.size;
    const remove =
      now - entry.mtimeMs > MAX_AGE_MS ||
      index >= MAX_FILES ||
      totalBytes > MAX_TOTAL_BYTES;
    if (!remove) continue;
    try {
      fs.unlinkSync(entry.filePath);
    } catch {}
  }
}

function status() {
  return { enabled: !!storeDir, dir: storeDir, ...stats };
}

module.exports = {
  init,
  compactMessages,
  read,
  status,
  _test: {
    maxInlineChars: MAX_INLINE_CHARS,
    defaultPreserveRecentToolResults: DEFAULT_PRESERVE_RECENT_TOOL_RESULTS,
    idFor: _idFor,
  },
};

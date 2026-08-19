"use strict";

const cp = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const SUMMARY_STATE_KEY_PREFIX =
  "windsurf.acp.session/summaryState/acp/devin-cli/";
const SUMMARY_AGENT_PREFIX = "acp/summary-agent/";
const DEFAULT_GLOBAL_STORAGE_DB = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Devin",
  "User",
  "globalStorage",
  "state.vscdb",
);
const SUMMARY_STATE_QUERY =
  "SELECT key, value FROM ItemTable WHERE key LIKE 'windsurf.acp.session/summaryState/acp/devin-cli/%'";

function validSessionId(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    !value.includes(",") &&
    !value.includes("\r") &&
    !value.includes("\n")
    ? value
    : "";
}

function primarySessionIdFromKey(key) {
  if (typeof key !== "string" || !key.startsWith(SUMMARY_STATE_KEY_PREFIX)) {
    return "";
  }
  return validSessionId(key.slice(SUMMARY_STATE_KEY_PREFIX.length));
}

function summarySessionIdFromValue(value) {
  if (typeof value !== "string") return "";
  try {
    const state = JSON.parse(value);
    const sessionId = validSessionId(state && state.prefixedSessionId);
    return sessionId && sessionId.startsWith(SUMMARY_AGENT_PREFIX) ? sessionId : "";
  } catch (_) {
    return "";
  }
}

function readSummaryStateRows(databasePath = process.env.DAO_ACP_GLOBAL_STORAGE_DB || DEFAULT_GLOBAL_STORAGE_DB) {
  if (typeof databasePath !== "string" || !databasePath) return [];
  try {
    const output = cp.execFileSync(
      "sqlite3",
      ["-json", databasePath, SUMMARY_STATE_QUERY],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 500 },
    );
    const rows = JSON.parse(output || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    return [];
  }
}

function resolveAcpModelSessionId(sessionId, { readRows = readSummaryStateRows } = {}) {
  const id = validSessionId(sessionId);
  if (!id || !id.startsWith(SUMMARY_AGENT_PREFIX)) return id;
  const owners = new Set();
  for (const row of readRows()) {
    const owner = primarySessionIdFromKey(row && row.key);
    const child = summarySessionIdFromValue(row && row.value);
    if (owner && child === id) owners.add(owner);
  }
  return owners.size === 1 ? [...owners][0] : id;
}

module.exports = {
  DEFAULT_GLOBAL_STORAGE_DB,
  resolveAcpModelSessionId,
  readSummaryStateRows,
};

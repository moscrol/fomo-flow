"use strict";

const budget = require("./budget");

const DEFAULT_THRESHOLD_RATIO = 0.1;
const SESSION_LIMIT = 256;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ACTIVE_DEFERRED = 24;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 16;

const sessions = new Map();
let log = () => {};
let lastStats = null;

function init(opts = {}) {
  log = typeof opts.log === "function" ? opts.log : () => {};
  sessions.clear();
  lastStats = null;
}

function _toolName(tool) {
  const fn = tool && (tool.function || tool);
  return String((fn && (fn.name || tool.name)) || "");
}

function _toolDescription(tool) {
  const fn = tool && (tool.function || tool);
  return String((fn && (fn.description || tool.description)) || "");
}

function _toolTokens(tools) {
  return budget.countTokens(JSON.stringify(tools || []), "o200k_base");
}

function _isDeferredCandidate(tool) {
  return /^mcp\d+_/i.test(_toolName(tool));
}

function _cleanup() {
  const now = Date.now();
  for (const [key, state] of sessions) {
    if (now - state.updatedAt > SESSION_TTL_MS) sessions.delete(key);
  }
}

function _touch(key, state) {
  sessions.delete(key);
  sessions.set(key, state);
  while (sessions.size > SESSION_LIMIT) sessions.delete(sessions.keys().next().value);
}

function _state(key) {
  _cleanup();
  const normalizedKey = String(key || "shared");
  let state = sessions.get(normalizedKey);
  if (!state) {
    state = {
      catalog: new Map(),
      active: [],
      updatedAt: Date.now(),
      searches: 0,
    };
    _touch(normalizedKey, state);
  }
  return { key: normalizedKey, state };
}

function _recentToolNames(messages) {
  const names = new Set();
  for (const message of (messages || []).slice(-24)) {
    if (!message || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const name = call && call.function && call.function.name;
      if (name) names.add(name);
    }
  }
  return names;
}

function _activate(state, names) {
  for (const name of names) {
    const index = state.active.indexOf(name);
    if (index >= 0) state.active.splice(index, 1);
    state.active.push(name);
  }
  while (state.active.length > MAX_ACTIVE_DEFERRED) state.active.shift();
  state.updatedAt = Date.now();
}

function select(input) {
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const maxContextTokens = Math.max(32768, Number(input.maxContextTokens) || 131072);
  const thresholdTokens = Math.max(
    2048,
    Math.floor(
      maxContextTokens *
        (Number(input.thresholdRatio) || DEFAULT_THRESHOLD_RATIO),
    ),
  );
  const deferredCandidates = tools.filter(_isDeferredCandidate);
  const deferredTokens = _toolTokens(deferredCandidates);
  const { key, state } = _state(input.key);

  state.catalog = new Map(deferredCandidates.map((tool) => [_toolName(tool), tool]));
  const recent = Array.from(_recentToolNames(input.messages)).filter((name) =>
    state.catalog.has(name),
  );
  _activate(state, recent);

  if (!deferredCandidates.length || deferredTokens <= thresholdTokens) {
    state.catalog.clear();
    lastStats = {
      key,
      enabled: false,
      originalTools: tools.length,
      sentTools: tools.length,
      deferredTools: 0,
      deferredTokens,
      thresholdTokens,
      activeDeferred: 0,
    };
    return { tools, stats: { ...lastStats } };
  }

  const active = new Set(state.active.filter((name) => state.catalog.has(name)));
  const selected = tools.filter(
    (tool) => !_isDeferredCandidate(tool) || active.has(_toolName(tool)),
  );
  state.updatedAt = Date.now();
  _touch(key, state);
  lastStats = {
    key,
    enabled: true,
    originalTools: tools.length,
    sentTools: selected.length,
    deferredTools: deferredCandidates.length - active.size,
    deferredTokens,
    thresholdTokens,
    activeDeferred: active.size,
  };
  log(
    `[tool-strategy] deferred=${lastStats.deferredTools}/${deferredCandidates.length} tokens=${deferredTokens}/${thresholdTokens} active=${active.size} key=${key}`,
  );
  return { tools: selected, stats: { ...lastStats } };
}

function _terms(text) {
  return Array.from(
    new Set(
      String(text || "")
        .toLowerCase()
        .replace(/[_./:-]+/g, " ")
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  );
}

function _intentAliases(query) {
  const aliases = [];
  const text = String(query || "").toLowerCase();
  if (/github|git|repository|repo|pull request|issue|仓库|提交|合并请求/.test(text))
    aliases.push("github", "repository", "pull_request", "issue", "commit");
  if (/browser|web|website|page|html|url|网页|页面|浏览器|网站/.test(text))
    aliases.push("browser", "navigate", "page", "snapshot", "click");
  if (/search|research|crawl|extract|搜索|检索|调研|网页/.test(text))
    aliases.push("search", "research", "crawl", "extract", "tavily");
  if (/docs|documentation|library|api|文档|接口|库/.test(text))
    aliases.push("docs", "documentation", "library", "resolve", "query");
  return aliases;
}

function search(input) {
  const { key, state } = _state(input.key);
  if (!state.catalog.size) {
    return {
      ok: true,
      query: String(input.query || ""),
      tools: [],
      note: "No deferred tools are currently available; all tools already fit the context budget.",
    };
  }
  const query = String(input.query || "").trim();
  const terms = [..._terms(query), ..._intentAliases(query)];
  const limit = Math.min(
    MAX_SEARCH_LIMIT,
    Math.max(1, Number(input.limit) || DEFAULT_SEARCH_LIMIT),
  );
  const scored = Array.from(state.catalog.entries()).map(([name, tool]) => {
    const description = _toolDescription(tool);
    const haystack = `${name.replace(/^mcp\d+_/, "")} ${description}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.toLowerCase() === term) score += 100;
      else if (name.toLowerCase().includes(term)) score += 20;
      else if (haystack.includes(term)) score += 4;
    }
    return { name, tool, description, score };
  });
  scored.sort(
    (left, right) =>
      right.score - left.score || left.name.localeCompare(right.name),
  );
  let matches = scored.filter((entry) => entry.score > 0).slice(0, limit);
  if (!matches.length) matches = scored.slice(0, limit);
  _activate(
    state,
    matches.map((entry) => entry.name),
  );
  state.searches++;
  _touch(key, state);
  return {
    ok: true,
    query,
    activated: matches.map((entry) => entry.name),
    tools: matches.map((entry) => ({
      name: entry.name,
      description:
        entry.description.length > 500
          ? `${entry.description.slice(0, 500)}…`
          : entry.description,
    })),
    note: "These tool schemas will be included in the next model round. Call the required tool by its exact name.",
  };
}

function status() {
  return {
    sessions: sessions.size,
    last: lastStats ? { ...lastStats } : null,
    searches: Array.from(sessions.values()).reduce(
      (sum, state) => sum + state.searches,
      0,
    ),
  };
}

module.exports = {
  init,
  select,
  search,
  status,
  _test: {
    toolTokens: _toolTokens,
    isDeferredCandidate: _isDeferredCandidate,
  },
};

"use strict";

const SESSION_LIMIT = 256;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const DIRECTIVE_START = "<!-- DAO-WORKSPACE-TOOL-DEGRADED -->";
const DIRECTIVE_END = "<!-- /DAO-WORKSPACE-TOOL-DEGRADED -->";
const DIRECTIVE = `${DIRECTIVE_START}
Workspace tool capability state:
- The editor may already have the project open, but its separate workspace-bound search executor rejected the current root. Do not claim that the user failed to open the project.
- Do not call CodeSearch, SmartReading, Grep, grep_search, FindByName, or find_by_name again in this conversation.
- Use Read or ListDir with the exact absolute path. If filename or textual search is required, run one narrowly targeted command from the exact project root; avoid broad recursive scans of the entire project.
- Do not retry an unchanged failed workspace-index tool call.
${DIRECTIVE_END}`;
const RECOVERY_START = "<!-- DAO-WORKSPACE-LOCAL-RECOVERY -->";
const RECOVERY_END = "<!-- /DAO-WORKSPACE-LOCAL-RECOVERY -->";
const RECOVERY_DIRECTIVE = `${RECOVERY_START}
Workspace search recovery state:
- The editor project is open. Its native Cortex workspace index failed earlier, but the proxy-local search executor is now active.
- You may call CodeSearch, SmartReading, Grep, grep_search, FindByName, or find_by_name again using the exact absolute project directory.
- Do not claim the workspace is unopened and do not replace a targeted search with a broad recursive shell command.
${RECOVERY_END}`;

const sessions = new Map();
let log = () => {};
let lastStats = null;
let localFallback = false;

function init(opts = {}) {
  log = typeof opts.log === "function" ? opts.log : () => {};
  localFallback = opts.localFallback === true;
  sessions.clear();
  lastStats = null;
}

function _fingerprint(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || null);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
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

function _contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function _normalizeRoot(root) {
  return String(root || "")
    .trim()
    .replace(/^[`'"<\[]+|[`'">\],;。；]+$/g, "")
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function _projectRoot(messages) {
  const label =
    /(?:项目(?:根目录|目录|路径)|工程(?:根目录|目录|路径)|project\s*(?:root|directory|path)|workspace\s*(?:root|directory|path))\s*(?::|：|=|is)\s*[`'"<\[]*([^\r\n`'">\]]+)/gi;
  let found = "";
  for (const message of messages || []) {
    if (!message || (message.role !== "system" && message.role !== "user")) continue;
    const text = _contentText(message.content);
    label.lastIndex = 0;
    let match;
    while ((match = label.exec(text))) {
      const candidate = _normalizeRoot(match[1]);
      if (/^(?:[a-z]:\/|\/)/i.test(candidate)) found = candidate;
    }
  }
  return found;
}

function _isWorkspaceIndexTool(name) {
  return /^(?:code_?search|smart_?reading|grep(?:_search)?|find_?by_?name)$/i.test(
    String(name || ""),
  );
}

function _isWorkspaceBoundaryError(text) {
  const value = String(text || "");
  return (
    /(?:IDE|编辑器).{0,24}(?:未注册|没有注册|未加载|未打开).{0,24}工作区/i.test(value) ||
    /工作区.{0,24}(?:未注册|没有注册|未加载|未打开)/i.test(value) ||
    /(?:绝对路径|路径).{0,32}(?:不在|不属于|超出|位于外部).{0,24}工作区/i.test(value) ||
    /workspace.{0,32}(?:not registered|is not registered|isn't registered|not loaded|not open)/i.test(value) ||
    /not (?:inside|within|part of) (?:any |the )?(?:current |IDE[- ]registered |registered )?workspace/i.test(value) ||
    /outside (?:the )?(?:IDE[- ]registered |registered )?workspace/i.test(value) ||
    /current open workspaces\s*:\s*(?:\r?\n)?\s*$/i.test(value) ||
    /workspace boundary/i.test(value) ||
    /no workspace folder (?:is )?(?:open|registered|loaded)/i.test(value)
  );
}

function _newState(rootIdentity) {
  return {
    rootIdentity: rootIdentity || "",
    disabled: new Set(),
    seenFailures: new Set(),
    failures: 0,
    updatedAt: Date.now(),
  };
}

function observe(input = {}) {
  _cleanup();
  const key = String(input.key || "shared");
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const rootIdentity = _projectRoot(messages);
  let state = sessions.get(key);

  if (state && rootIdentity && state.rootIdentity !== rootIdentity) {
    state = _newState(rootIdentity);
    _touch(key, state);
    log(
      `[workspace-tool-strategy] project root changed; reset key=${_fingerprint(key)} root=${_fingerprint(rootIdentity)}`,
    );
    return _snapshot(key, state, true);
  }

  if (!state) state = _newState(rootIdentity);
  else if (!state.rootIdentity && rootIdentity) state.rootIdentity = rootIdentity;

  const callNames = new Map();
  for (const message of messages) {
    if (!message || message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const id = call && call.id;
      const name = call && call.function && call.function.name;
      if (id && name) callNames.set(id, name);
    }
  }

  let newlyDisabled = false;
  for (const message of messages) {
    if (!message || message.role !== "tool" || !message.tool_call_id) continue;
    const toolName = callNames.get(message.tool_call_id) || "";
    const text = _contentText(message.content);
    if (!_isWorkspaceIndexTool(toolName) || !_isWorkspaceBoundaryError(text)) continue;
    const failureId = `${message.tool_call_id}:${_fingerprint(text)}`;
    if (state.seenFailures.has(failureId)) continue;
    state.seenFailures.add(failureId);
    state.failures++;
    state.disabled.add("CodeSearch");
    state.disabled.add("code_search");
    state.disabled.add("SmartReading");
    state.disabled.add("smart_reading");
    state.disabled.add("Grep");
    state.disabled.add("grep_search");
    state.disabled.add("FindByName");
    state.disabled.add("find_by_name");
    newlyDisabled = true;
  }

  while (state.seenFailures.size > 32) {
    state.seenFailures.delete(state.seenFailures.values().next().value);
  }
  state.updatedAt = Date.now();
  _touch(key, state);
  if (newlyDisabled) {
    log(
      `[workspace-tool-strategy] workspace index tools disabled key=${_fingerprint(key)} failures=${state.failures}`,
    );
  }
  return _snapshot(key, state, false);
}

function _snapshot(key, state, reset) {
  const snapshot = {
    keyHash: _fingerprint(key),
    rootHash: state.rootIdentity ? _fingerprint(state.rootIdentity) : null,
    disabled: Array.from(state.disabled),
    degraded: state.disabled.size > 0,
    failures: state.failures,
    reset: !!reset,
  };
  lastStats = snapshot;
  return { ...snapshot, disabled: [...snapshot.disabled] };
}

function filterTools(input = {}) {
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const key = String(input.key || "shared");
  const state = sessions.get(key);
  if (!state || state.disabled.size === 0) return tools;
  if (localFallback) return tools;
  return tools.filter((tool) => {
    const fn = tool && (tool.function || tool);
    const name = String((fn && (fn.name || tool.name)) || "");
    return !_isWorkspaceIndexTool(name);
  });
}

function isLocalFallbackActive(input = {}) {
  const key = String(input.key || "shared");
  const state = sessions.get(key);
  return !!(localFallback && state && state.disabled.size > 0);
}

function _stripDirective(text) {
  let value = String(text || "");
  for (const [startMarker, endMarker] of [
    [DIRECTIVE_START, DIRECTIVE_END],
    [RECOVERY_START, RECOVERY_END],
  ]) {
    const start = value.indexOf(startMarker);
    if (start < 0) continue;
    const end = value.indexOf(endMarker, start);
    value = end < 0
      ? value.slice(0, start).trim()
      : `${value.slice(0, start)}${value.slice(end + endMarker.length)}`.trim();
  }
  return value;
}

function decorateMessages(input = {}) {
  const key = String(input.key || "shared");
  const state = sessions.get(key);
  const degraded = !!(state && state.disabled.size > 0);
  const output = (Array.isArray(input.messages) ? input.messages : []).map((message) => ({
    ...message,
  }));
  const systemIndex = output.findIndex((message) => message && message.role === "system");
  const activeDirective = localFallback ? RECOVERY_DIRECTIVE : DIRECTIVE;
  if (systemIndex < 0) {
    if (degraded) output.unshift({ role: "system", content: activeDirective });
    return output;
  }
  const base = _stripDirective(output[systemIndex].content);
  output[systemIndex].content = degraded
    ? `${base}\n\n${activeDirective}`.trim()
    : base;
  return output;
}

function status() {
  return {
    sessions: sessions.size,
    degradedSessions: Array.from(sessions.values()).filter(
      (state) => state.disabled.size > 0,
    ).length,
    last: lastStats ? { ...lastStats, disabled: [...lastStats.disabled] } : null,
    localFallback,
  };
}

module.exports = {
  init,
  observe,
  filterTools,
  isLocalFallbackActive,
  decorateMessages,
  status,
  _test: {
    directive: DIRECTIVE,
    recoveryDirective: RECOVERY_DIRECTIVE,
    isWorkspaceBoundaryError: _isWorkspaceBoundaryError,
    isWorkspaceIndexTool: _isWorkspaceIndexTool,
    projectRoot: _projectRoot,
  },
};

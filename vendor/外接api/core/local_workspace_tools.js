"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

const MAX_FILES = 5000;
const MAX_RESULTS = 80;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_MS = 1800;
const MAX_RESOLVE_DIRS = 600;
const MAX_RESOLVE_MS = 100;
const SKIP_DIRS = new Set([
  ".git", ".svn", ".hg", ".vs", ".idea", "node_modules", "Library",
  "Temp", "obj", "bin", "Logs", "Build", "Builds", "UserSettings",
]);
const LOCAL_NAMES = new Set([
  "code_search", "CodeSearch", "grep_search", "Grep", "GrepSearch",
  "find_by_name", "FindByName", "smart_reading", "SmartReading",
]);
const SEARCH_PATH_KEYS = [
  "search_folder_absolute_uri", "SearchFolderAbsoluteUri",
  "SearchPath", "searchPath", "SearchDirectory", "searchDirectory",
  "DirectoryPath", "directoryPath", "folder", "directory", "root", "path",
];

function asObject(argsJson) {
  try {
    const parsed = typeof argsJson === "string" ? JSON.parse(argsJson || "{}") : argsJson;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function value(args, names) {
  for (const name of names) {
    if (typeof args[name] === "string" && args[name].trim()) return args[name].trim();
  }
  return "";
}

function toPath(valueToConvert) {
  const raw = String(valueToConvert || "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return "";
  try {
    if (/^file:\/\//i.test(raw)) return fileURLToPath(raw);
  } catch (_) {}
  if (process.platform === "win32" && /^\/[a-z]:[\\/]/i.test(raw)) return raw.slice(1);
  return raw;
}

function pathField(args) {
  return SEARCH_PATH_KEYS.find((key) => typeof args[key] === "string" && args[key].trim()) || "";
}

function existingDirectory(candidate) {
  try {
    return !!candidate && fs.statSync(candidate).isDirectory();
  } catch (_) {
    return false;
  }
}

function uniqueExistingRoots(values) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const resolved = path.resolve(toPath(value));
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!existingDirectory(resolved) || seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function workspaceRoots(env = process.env) {
  const values = [];
  try {
    const parsed = JSON.parse(env.DAO_WORKSPACE_ROOTS || "[]");
    if (Array.isArray(parsed)) values.push(...parsed);
  } catch (_) {}
  if (env.DAO_WORKSPACE_ROOT) values.push(env.DAO_WORKSPACE_ROOT);
  return uniqueExistingRoots(values);
}

function workspaceRootsFromText(text) {
  const source = String(text || "");
  if (!source) return [];
  const values = [];
  const labeledPatterns = [
    /(?:项目根目录|项目路径|工作区根目录|当前工作目录|workspace\s+root|working\s+directory)\s*[:：]\s*([^\r\n<]+)/gi,
    /<workspace_information[^>]*>\s*([^<\r\n]+)\s*<\/workspace_information>/gi,
  ];
  for (const pattern of labeledPatterns) {
    let match;
    while ((match = pattern.exec(source)) !== null && values.length < 8) {
      values.push(match[1].trim().replace(/^['"`]|['"`]$/g, ""));
    }
  }
  return uniqueExistingRoots(values);
}

function recentSearchDirectories(messages) {
  const values = [];
  for (let messageIndex = (messages || []).length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (let callIndex = message.tool_calls.length - 1; callIndex >= 0; callIndex--) {
      const call = message.tool_calls[callIndex] || {};
      const fn = call.function || call;
      if (!LOCAL_NAMES.has(String(fn.name || call.name || ""))) continue;
      const args = asObject(fn.arguments || call.argumentsJson || "{}");
      const field = pathField(args);
      if (field) values.push(toPath(args[field]));
      if (values.length >= 8) return uniqueExistingRoots(values);
    }
  }
  return uniqueExistingRoots(values);
}

function insideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shallowUniqueDirectory(roots, relativePath) {
  const deadline = Date.now() + MAX_RESOLVE_MS;
  const wanted = String(relativePath || "").replace(/[\\/]+/g, path.sep).replace(/^[\\/]+|[\\/]+$/g, "");
  if (!wanted || wanted === "." || wanted.startsWith(".." + path.sep) || wanted === "..") return "";
  const wantedLower = wanted.toLowerCase();
  const matches = [];
  const queue = roots.slice();
  let visited = 0;
  while (queue.length && visited < MAX_RESOLVE_DIRS && Date.now() <= deadline) {
    const current = queue.shift();
    visited++;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const normalized = full.toLowerCase();
      if (normalized === wantedLower || normalized.endsWith(path.sep + wantedLower)) {
        matches.push(full);
        if (matches.length > 1) return "";
      }
      if (queue.length + visited < MAX_RESOLVE_DIRS) queue.push(full);
    }
  }
  return matches.length === 1 ? matches[0] : "";
}

function serializeResolvedPath(field, resolved) {
  // Despite its historical `*_uri` name, Devin's Windows executor validates
  // this value with native absolute-path semantics and rejects file:// URIs.
  // Forward slashes keep it absolute while avoiding invalid JSON escapes in
  // Fast Context's nested tool calls.
  return /uri/i.test(field) ? resolved.replace(/\\/g, "/") : resolved;
}

function workspaceRelativePath(raw) {
  if (!raw) return "";
  if (
    process.platform === "win32" &&
    /^[\\/](?![\\/])/.test(raw) &&
    !/^[\\/][a-z]:[\\/]/i.test(raw)
  ) {
    return raw.replace(/^[\\/]+/, "");
  }
  return path.isAbsolute(raw) ? "" : raw;
}

function uniqueDirectories(values) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const resolved = path.resolve(value);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key) || !existingDirectory(resolved)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function immediateChildCandidates(roots, relativePath) {
  const candidates = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      candidates.push(path.resolve(root, entry.name, relativePath));
    }
  }
  return uniqueDirectories(candidates);
}

function normalizeToolCall(name, argsJson, context = {}) {
  const original = typeof argsJson === "string" ? argsJson : JSON.stringify(argsJson || {});
  if (!LOCAL_NAMES.has(String(name || ""))) return { changed: false, argumentsJson: original };
  const args = asObject(original);
  const field = pathField(args);
  if (!field) return { changed: false, argumentsJson: original, reason: "missing-path-field" };
  const raw = toPath(args[field]);
  if (!raw) return { changed: false, argumentsJson: original, field, reason: "empty-path" };
  const relativePath = workspaceRelativePath(raw);
  if (!relativePath) {
    // Devin validates this historically named `*_uri` field as a native
    // absolute path. Normalize Windows separators without adding file://:
    // E:/... remains absolute and cannot create JSON escapes such as `\R` in
    // the native Fast Context agent's nested tool calls.
    if (/uri/i.test(field)) {
      const resolved = path.resolve(raw);
      if (existingDirectory(resolved)) {
        const serialized = serializeResolvedPath(field, resolved);
        const pathChanged = args[field] !== serialized;
        if (pathChanged) args[field] = serialized;
        if (pathChanged) {
          return {
            changed: true,
            argumentsJson: JSON.stringify(args),
            field,
            from: raw,
            to: resolved,
            reason: "absolute-path-forward-slashes",
          };
        }
      }
    }
    return { changed: false, argumentsJson: original, field, from: raw, reason: "valid-absolute" };
  }

  const roots = uniqueExistingRoots((context.workspaceRoots || []).concat(workspaceRoots(context.env || process.env)));
  const recent = uniqueExistingRoots((context.recentDirectories || []).concat(recentSearchDirectories(context.messages || [])));
  if (!roots.length && !recent.length) {
    return { changed: false, argumentsJson: original, field, from: raw, reason: "no-workspace-root", roots: [] };
  }
  const candidatesFrom = (bases) => {
    const candidates = [];
    const seen = new Set();
    for (const base of bases) {
      const candidate = path.resolve(base, relativePath);
      const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key) || (roots.length && !roots.some((root) => insideRoot(candidate, root)))) continue;
      seen.add(key);
      if (existingDirectory(candidate)) candidates.push(candidate);
    }
    return candidates;
  };
  const recentCandidates = candidatesFrom(recent);
  const rootCandidates = candidatesFrom(roots);
  const childCandidates = immediateChildCandidates(roots, relativePath);
  let resolved = recentCandidates[0] ||
    (rootCandidates.length === 1 ? rootCandidates[0] : "") ||
    (childCandidates.length === 1 ? childCandidates[0] : "");
  let reason = recentCandidates.length
    ? "relative-to-recent"
    : resolved
      ? rootCandidates.length === 1
        ? "relative-to-workspace-root"
        : "relative-to-workspace-child"
      : "";
  const ambiguousRoots = !recentCandidates.length &&
    (rootCandidates.length > 1 || childCandidates.length > 1);
  if (!resolved && !ambiguousRoots) {
    resolved = shallowUniqueDirectory(roots, relativePath);
    if (resolved) reason = "unique-workspace-directory";
  }
  if (!resolved) {
    return {
      changed: false,
      argumentsJson: original,
      field,
      from: raw,
      reason: ambiguousRoots ? "ambiguous-workspace-path" : "unresolved-workspace-path",
      roots,
    };
  }
  args[field] = serializeResolvedPath(field, resolved);
  return {
    changed: true,
    argumentsJson: JSON.stringify(args),
    field,
    from: raw,
    to: resolved,
    reason,
  };
}

function searchRoot(args) {
  return toPath(value(args, [
    "search_folder_absolute_uri", "SearchPath", "SearchDirectory", "DirectoryPath", "path",
  ]));
}

function canHandle(name, argsJson) {
  if (!LOCAL_NAMES.has(String(name || ""))) return false;
  const root = searchRoot(asObject(argsJson));
  try {
    return !!root && fs.statSync(root).isDirectory();
  } catch (_) {
    return false;
  }
}

function canHandleWithinRoots(name, argsJson, roots) {
  if (!canHandle(name, argsJson)) return false;
  const candidate = path.resolve(searchRoot(asObject(argsJson)));
  return uniqueExistingRoots(roots || []).some((root) => insideRoot(candidate, root));
}

function isTextFile(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const sample = Buffer.allocUnsafe(1024);
    const size = fs.readSync(fd, sample, 0, sample.length, 0);
    fs.closeSync(fd);
    return !sample.subarray(0, size).includes(0);
  } catch (_) {
    return false;
  }
}

function walkFiles(root, deadline) {
  const files = [];
  const stack = [path.resolve(root)];
  while (stack.length && files.length < MAX_FILES && Date.now() < deadline) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (Date.now() >= deadline || files.length >= MAX_FILES) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.size <= MAX_FILE_BYTES && isTextFile(full)) files.push(full);
      } catch (_) {}
    }
  }
  return files;
}

function globRegex(pattern) {
  const escaped = String(pattern || "*").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return "";
  }
}

function findByName(root, pattern, deadline) {
  const matcher = globRegex(pattern || "*");
  return walkFiles(root, deadline)
    .filter((filePath) => matcher.test(path.basename(filePath)))
    .slice(0, MAX_RESULTS)
    .map((filePath) => ({ path: filePath }));
}

function grep(root, query, deadline) {
  const needle = String(query || "").trim();
  if (!needle) return [];
  let matcher;
  try {
    matcher = new RegExp(needle, "i");
  } catch (_) {
    matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const results = [];
  for (const filePath of walkFiles(root, deadline)) {
    if (Date.now() >= deadline || results.length >= MAX_RESULTS) break;
    const lines = readText(filePath).split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (!matcher.test(lines[index])) continue;
      results.push({ path: filePath, line: index + 1, text: lines[index].slice(0, 500) });
      if (results.length >= MAX_RESULTS) break;
    }
  }
  return results;
}

function codeSearch(root, query, deadline) {
  const terms = Array.from(new Set(
    String(query || "").match(/[A-Za-z_][A-Za-z0-9_.-]{2,}|[\u3400-\u9fff]{2,}/g) || [],
  )).slice(0, 8);
  if (!terms.length) return [];
  const ranked = [];
  for (const filePath of walkFiles(root, deadline)) {
    if (Date.now() >= deadline) break;
    const lower = readText(filePath).toLowerCase();
    const score = terms.reduce(
      (sum, term) => sum + lower.split(term.toLowerCase()).length - 1,
      0,
    );
    if (score > 0) ranked.push({ path: filePath, score });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
}

function execute(name, argsJson) {
  const args = asObject(argsJson);
  const root = searchRoot(args);
  const deadline = Date.now() + MAX_SCAN_MS;
  let results;
  if (/find_?by_?name/i.test(name)) {
    results = findByName(root, value(args, ["Pattern", "pattern", "query"]), deadline);
  } else if (/code_?search|smart_?reading/i.test(name)) {
    results = codeSearch(root, value(args, ["search_term", "SearchTerm", "query"]), deadline);
  } else {
    results = grep(root, value(args, ["Query", "query", "search_term"]), deadline);
  }
  return JSON.stringify({
    ok: true,
    source: "dao-local-workspace",
    root: path.resolve(root),
    results,
    truncated: Date.now() >= deadline,
  });
}

module.exports = {
  canHandle,
  canHandleWithinRoots,
  execute,
  names: LOCAL_NAMES,
  normalizeToolCall,
  workspaceRoots,
  workspaceRootsFromText,
  recentSearchDirectories,
};

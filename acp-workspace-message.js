"use strict";

const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { Transform } = require("node:stream");

function normalizeRoot(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return path.resolve(value.trim()).replace(/[\\/]+$/, "");
}

function rootKey(value) {
  const normalized = normalizeRoot(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function uniqueRoots(values) {
  const roots = [];
  const seen = new Set();
  for (const value of values || []) {
    const root = normalizeRoot(value);
    const key = rootKey(root);
    if (!root || seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

function workspaceRootsFromEnv(env = process.env) {
  let roots = [];
  if (env.DAO_WORKSPACE_ROOTS) {
    try {
      const parsed = JSON.parse(env.DAO_WORKSPACE_ROOTS);
      if (Array.isArray(parsed)) roots = parsed;
    } catch (_) {
      // A malformed optional multi-root value must not break ACP startup.
    }
  }
  if (env.DAO_WORKSPACE_ROOT) roots.unshift(env.DAO_WORKSPACE_ROOT);
  return uniqueRoots(roots);
}

function isInsideRoot(candidate, root) {
  const candidateKey = rootKey(candidate);
  const rootPathKey = rootKey(root);
  if (!candidateKey || !rootPathKey) return false;
  return candidateKey === rootPathKey || candidateKey.startsWith(rootPathKey + path.sep);
}

function rewriteAuthenticateApiServerLine(line, apiServerUrl) {
  if (!line || !apiServerUrl || !line.includes("authenticate")) {
    return { line, changed: false };
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch (_) {
    return { line, changed: false };
  }
  if (!message || message.method !== "authenticate" || !message.params) {
    return { line, changed: false };
  }
  const meta = message.params.meta || message.params._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return { line, changed: false };
  }
  if (meta.api_server_url === apiServerUrl) return { line, changed: false };
  meta.api_server_url = apiServerUrl;
  return { line: JSON.stringify(message), changed: true };
}

function rewriteSessionNewLine(line, workspaceRoots) {
  let roots = uniqueRoots(workspaceRoots);
  if (!line || !line.includes("session/new")) {
    return { line, changed: false };
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch (_) {
    return { line, changed: false };
  }
  if (
    !message ||
    message.method !== "session/new" ||
    !message.params ||
    typeof message.params !== "object" ||
    Array.isArray(message.params)
  ) {
    return { line, changed: false };
  }

  const params = message.params;
  const hadConfiguredRoots = roots.length > 0;
  if (!hadConfiguredRoots) {
    // Devin can open a project without exposing it through VS Code's
    // workspaceFolders API. In that mode session/new is the only reliable
    // workspace source available to the stdio proxy.
    roots = uniqueRoots([
      params.cwd,
      ...(Array.isArray(params.additionalDirectories)
        ? params.additionalDirectories
        : []),
    ]);
    if (!roots.length) return { line, changed: false };
  }
  const currentCwd = normalizeRoot(params.cwd);
  const cwdBelongsToWorkspace = roots.some((root) => isInsideRoot(currentCwd, root));
  if (!cwdBelongsToWorkspace) params.cwd = roots[0];

  const effectiveCwd = normalizeRoot(params.cwd);
  const additional = Array.isArray(params.additionalDirectories)
    ? params.additionalDirectories.filter(
        (entry) => typeof entry === "string" && entry.trim(),
      )
    : [];
  const additions = roots.filter(
    (root) => !isInsideRoot(effectiveCwd, root) && !isInsideRoot(root, effectiveCwd),
  );
  const mergedAdditional = uniqueRoots([...additional, ...additions]);
  if (
    !hadConfiguredRoots &&
    effectiveCwd &&
    !mergedAdditional.some((entry) => rootKey(entry) === rootKey(effectiveCwd))
  ) {
    // Some Cortex search sessions do not register cwd as a searchable root
    // unless it is also present in additionalDirectories.
    mergedAdditional.unshift(effectiveCwd);
  }
  const oldAdditional = Array.isArray(params.additionalDirectories)
    ? uniqueRoots(params.additionalDirectories)
    : [];
  const additionalChanged =
    mergedAdditional.length !== oldAdditional.length ||
    mergedAdditional.some(
      (entry, index) => rootKey(entry) !== rootKey(oldAdditional[index]),
    );
  if (mergedAdditional.length) params.additionalDirectories = mergedAdditional;

  const cwdChanged = rootKey(currentCwd) !== rootKey(effectiveCwd);
  if (!cwdChanged && !additionalChanged) return { line, changed: false };

  return {
    line: JSON.stringify(message),
    changed: true,
    cwd: effectiveCwd,
    additionalDirectories: mergedAdditional,
    workspaceRoots: roots,
  };
}

function createWorkspaceInputTransform(workspaceRoots, onRewrite, apiServerUrl, rewriteLine) {
  let roots = uniqueRoots(workspaceRoots);
  const decoder = new StringDecoder("utf8");
  let pending = "";

  function emitLine(stream, rawLine, ending) {
    const authResult = rewriteAuthenticateApiServerLine(rawLine, apiServerUrl);
    const result = rewriteSessionNewLine(authResult.line, roots);
    const customResult =
      typeof rewriteLine === "function" ? rewriteLine(result.line) : null;
    const finalLine =
      customResult && typeof customResult.line === "string"
        ? customResult.line
        : result.line;
    if (Array.isArray(result.workspaceRoots)) roots = result.workspaceRoots;
    if (
      (authResult.changed || result.changed || (customResult && customResult.changed)) &&
      typeof onRewrite === "function"
    ) {
      onRewrite(result.changed ? result : authResult);
    }
    stream.push(finalLine + ending);
  }

  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk);
      let newlineIndex;
      while ((newlineIndex = pending.indexOf("\n")) >= 0) {
        let line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        let ending = "\n";
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
          ending = "\r\n";
        }
        emitLine(this, line, ending);
      }
      callback();
    },
    flush(callback) {
      pending += decoder.end();
      if (pending) emitLine(this, pending, "");
      callback();
    },
  });
}

module.exports = {
  createWorkspaceInputTransform,
  isInsideRoot,
  rewriteAuthenticateApiServerLine,
  rewriteSessionNewLine,
  uniqueRoots,
  workspaceRootsFromEnv,
};

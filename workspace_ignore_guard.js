"use strict";

const fs = require("node:fs");
const path = require("node:path");

const IGNORE_FILE = ".codeiumignore";
const UNSAFE_UNITY_LIBRARY_RULE = /^(\s*)Library\/(\s*)$/;

function normalizeCodeiumIgnore(content) {
  if (typeof content !== "string" || !content) {
    return { changed: false, content: content || "" };
  }

  let changed = false;
  const normalized = content
    .split(/(\r?\n)/)
    .map((part) => {
      if (part === "\r\n" || part === "\n") return part;
      const match = UNSAFE_UNITY_LIBRARY_RULE.exec(part);
      if (!match) return part;
      changed = true;
      return `${match[1]}/Library/${match[2]}`;
    })
    .join("");

  return { changed, content: normalized };
}

function repairWorkspaceIgnoreFile(root, fileSystem = fs) {
  if (typeof root !== "string" || !root.trim()) {
    return { changed: false, reason: "invalid-root" };
  }

  const ignorePath = path.join(root, IGNORE_FILE);
  if (!fileSystem.existsSync(ignorePath)) {
    return { changed: false, reason: "missing", path: ignorePath };
  }

  const before = fileSystem.readFileSync(ignorePath, "utf8");
  const result = normalizeCodeiumIgnore(before);
  if (!result.changed) {
    return { changed: false, reason: "clean", path: ignorePath };
  }

  const temporaryPath = `${ignorePath}.dao-tmp-${process.pid}`;
  try {
    fileSystem.writeFileSync(temporaryPath, result.content, "utf8");
    fileSystem.renameSync(temporaryPath, ignorePath);
  } catch (error) {
    try {
      if (fileSystem.existsSync(temporaryPath)) fileSystem.unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }

  return { changed: true, reason: "repaired", path: ignorePath };
}

function workspaceRoots(vscode) {
  return (vscode.workspace.workspaceFolders || [])
    .map((folder) => folder && folder.uri && folder.uri.fsPath)
    .filter((root) => typeof root === "string" && root.trim());
}

function repairWorkspaceIgnoreFiles(vscode, log = {}) {
  const results = [];
  for (const root of workspaceRoots(vscode)) {
    try {
      const result = repairWorkspaceIgnoreFile(root);
      results.push(result);
      if (result.changed && typeof log.info === "function") {
        log.info(`anchored Unity Library ignore rule: ${result.path}`);
      }
    } catch (error) {
      results.push({ changed: false, reason: "error", root, error });
      if (typeof log.warn === "function") {
        log.warn(`unable to repair ${path.join(root, IGNORE_FILE)}: ${error.message}`);
      }
    }
  }
  return results;
}

function installWorkspaceIgnoreGuard(vscode, context, log = {}) {
  const repair = () => repairWorkspaceIgnoreFiles(vscode, log);
  repair();

  if (
    vscode.workspace &&
    typeof vscode.workspace.onDidChangeWorkspaceFolders === "function"
  ) {
    const disposable = vscode.workspace.onDidChangeWorkspaceFolders(repair);
    if (context && Array.isArray(context.subscriptions)) {
      context.subscriptions.push(disposable);
    }
  }

  return repair;
}

module.exports = {
  normalizeCodeiumIgnore,
  repairWorkspaceIgnoreFile,
  repairWorkspaceIgnoreFiles,
  installWorkspaceIgnoreGuard,
};

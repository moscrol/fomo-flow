"use strict";

const path = require("node:path");

const STATUS_LABELS = Object.freeze({
  A: "新增",
  D: "删除",
  M: "修改",
  "?": "基线未知",
});

function changeFromResource(tracker, resource) {
  if (resource && resource.changeId) {
    const state = tracker.getState();
    return state.changes.find((change) => change.id === resource.changeId) || null;
  }
  if (resource && resource.resourceUri && resource.resourceUri.fsPath) {
    return tracker.getChangeByFilePath(resource.resourceUri.fsPath);
  }
  return null;
}

function createCodexScmBridge(vscode, tracker, options = {}) {
  const commandPrefix = options.commandPrefix || "fomo.codexChanges";
  const sourceControl = vscode.scm.createSourceControl(
    "fomoCodexChanges",
    "Codex / Devin 文件变更",
  );
  const group = sourceControl.createResourceGroup("workingTree", "已同步文件变更");
  sourceControl.inputBox.visible = false;

  const beforeUri = options.beforeUri;
  const openDiff = options.openDiff;
  sourceControl.quickDiffProvider = {
    provideOriginalResource(uri) {
      const change = uri && uri.fsPath ? tracker.getChangeByFilePath(uri.fsPath) : null;
      if (!change || !change.beforeExists || !change.beforeAvailable || !beforeUri) return undefined;
      return beforeUri(change);
    },
  };

  function render(state) {
    const changes = state && Array.isArray(state.changes) ? state.changes : [];
    group.resourceStates = changes.map((change) => {
      const statusLabel = STATUS_LABELS[change.status] || "修改";
      const resource = {
        resourceUri: vscode.Uri.file(change.filePath),
        changeId: change.id,
        contextValue: `daoCodexChange.${change.status}`,
        command: {
          command: `${commandPrefix}.open`,
          title: "打开精确差异",
          arguments: [change.id],
        },
        decorations: {
          strikeThrough: change.status === "D",
          faded: change.status === "D",
          tooltip: `${statusLabel} | 磁盘已校验 | ${change.fingerprint}`,
        },
      };
      return resource;
    });
    sourceControl.count = changes.length;
  }

  async function withChange(resourceOrId, action) {
    const change = typeof resourceOrId === "string"
      ? tracker.getState().changes.find((entry) => entry.id === resourceOrId)
      : changeFromResource(tracker, resourceOrId);
    if (!change) throw new Error("The selected synchronized change no longer exists");
    return action(change);
  }

  const registrations = [
    vscode.commands.registerCommand(`${commandPrefix}.open`, (resourceOrId) =>
      withChange(resourceOrId, (change) => openDiff(change.id))),
    vscode.commands.registerCommand(`${commandPrefix}.accept`, (resourceOrId) =>
      withChange(resourceOrId, (change) => tracker.accept(change.id))),
    vscode.commands.registerCommand(`${commandPrefix}.reject`, (resourceOrId) =>
      withChange(resourceOrId, (change) => tracker.reject(change.id))),
  ];
  const listener = tracker.onDidChange(render);
  render(tracker.getState());

  return {
    sourceControl,
    group,
    render,
    dispose() {
      listener.dispose();
      for (const registration of registrations) registration.dispose();
      sourceControl.dispose();
    },
  };
}

module.exports = {
  STATUS_LABELS,
  changeFromResource,
  createCodexScmBridge,
};

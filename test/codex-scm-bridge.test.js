"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexChangeTracker } = require("../core/codex_change_tracker");
const { createCodexScmBridge } = require("../core/codex_scm_bridge");

async function main() {
  const commands = new Map();
  const disposables = [];
  const group = { resourceStates: [] };
  const sourceControl = {
    inputBox: {},
    count: 0,
    createResourceGroup() { return group; },
    dispose() { this.disposed = true; },
  };
  const vscode = {
    Uri: {
      file(filePath) { return { scheme: "file", fsPath: filePath }; },
    },
    scm: {
      createSourceControl(id, label) {
        assert.strictEqual(id, "fomoCodexChanges");
        assert.match(label, /Codex/);
        return sourceControl;
      },
    },
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        const disposable = { dispose() { commands.delete(id); } };
        disposables.push(disposable);
        return disposable;
      },
    },
  };

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dao-codex-scm-"));
  const source = path.join(temp, "Feature.cs");
  fs.writeFileSync(source, "class Feature {}\n", "utf8");
  const tracker = new CodexChangeTracker({ debounceMs: 1 });
  await tracker.start([temp]);
  let opened = "";
  const bridge = createCodexScmBridge(vscode, tracker, {
    beforeUri(change) { return { scheme: "dao-codex-change", id: change.id }; },
    async openDiff(id) { opened = id; },
  });

  fs.writeFileSync(source, "class Feature { int value = 2; }\n", "utf8");
  tracker.notifyPath(source, "codex-app-server");
  await tracker.flush();
  assert.strictEqual(group.resourceStates.length, 1);
  assert.strictEqual(sourceControl.count, 1);
  const resource = group.resourceStates[0];
  assert.match(resource.decorations.tooltip, /磁盘已校验/);
  assert.strictEqual(
    sourceControl.quickDiffProvider.provideOriginalResource(resource.resourceUri).scheme,
    "dao-codex-change",
  );

  await commands.get("fomo.codexChanges.open")(resource);
  assert.strictEqual(opened, resource.changeId);
  await commands.get("fomo.codexChanges.accept")(resource);
  assert.strictEqual(group.resourceStates.length, 0);

  fs.writeFileSync(source, "class Feature { int value = 3; }\n", "utf8");
  tracker.notifyPath(source, "editor-save");
  await tracker.flush();
  const second = group.resourceStates[0];
  await tracker.stop();
  await commands.get("fomo.codexChanges.reject")(second);
  assert.strictEqual(fs.readFileSync(source, "utf8"), "class Feature { int value = 2; }\n");

  bridge.dispose();
  await tracker.dispose();
  fs.rmSync(temp, { recursive: true, force: true });
  assert.strictEqual(sourceControl.disposed, true);
  console.log("codex scm bridge selftest: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexChangeTracker } = require("../core/codex_change_tracker");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dao-codex-changes-"));
  const firstRoot = path.join(temp, "project-a");
  const secondRoot = path.join(temp, "project-b");
  const source = path.join(firstRoot, "Assets", "Scripts", "Feature.cs");
  const assetLibrarySource = path.join(firstRoot, "Assets", "Library", "Page.uxml");
  const generated = path.join(firstRoot, "Library", "Generated.cs");
  const binaryText = path.join(firstRoot, "Assets", "binary.txt");
  const largeText = path.join(firstRoot, "Assets", "large.txt");
  const secondSource = path.join(secondRoot, "src", "index.ts");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(assetLibrarySource), { recursive: true });
  fs.mkdirSync(path.dirname(generated), { recursive: true });
  fs.mkdirSync(path.dirname(secondSource), { recursive: true });
  fs.writeFileSync(source, "class Feature {\n  int value = 1;\n}\n", "utf8");
  fs.writeFileSync(assetLibrarySource, "<ui:UXML />\n", "utf8");
  fs.writeFileSync(generated, "generated\n", "utf8");
  fs.writeFileSync(binaryText, Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(largeText, "x".repeat(100), "utf8");
  fs.writeFileSync(secondSource, "export const value = 1;\n", "utf8");

  const tracker = new CodexChangeTracker({ debounceMs: 1, maxFileBytes: 64 });
  await tracker.start([firstRoot, secondRoot]);
  let state = tracker.getState();
  assert.strictEqual(state.active, true);
  assert(state.snapshotFiles >= 3, "both roots and Assets/Library must be snapshotted");
  assert(!Array.from(tracker.baseline.values()).some((entry) => entry.filePath === generated), "root Library must be ignored");
  assert(Array.from(tracker.baseline.values()).some((entry) => entry.filePath === assetLibrarySource), "Assets/Library must remain reviewable");
  assert(!Array.from(tracker.baseline.values()).some((entry) => entry.filePath === binaryText), "binary content must be ignored");
  assert(!Array.from(tracker.baseline.values()).some((entry) => entry.filePath === largeText), "oversized files must be ignored");

  fs.writeFileSync(source, "class Feature {\n  int value = 2;\n  void Run() {}\n}\n", "utf8");
  tracker.notifyPath(source);
  await tracker.flush();
  state = tracker.getState();
  assert.strictEqual(state.changes.length, 1);
  assert.strictEqual(state.changes[0].status, "M");
  assert.strictEqual(state.changes[0].syncStatus, "disk-verified");
  assert.match(state.changes[0].fingerprint, /^[a-f0-9]{64}:[a-f0-9]{64}$/);
  assert.strictEqual(tracker.getBeforeContent(state.changes[0].id), "class Feature {\n  int value = 1;\n}\n");
  assert(state.changes[0].additions > 0 && state.changes[0].deletions > 0);

  tracker.notifyPath(source, "editor-save");
  tracker.notifyPath(source, "codex-app-server");
  await tracker.flush();
  state = tracker.getState();
  assert.deepStrictEqual(state.changes[0].sources, ["codex-app-server", "editor-save", "filesystem"]);
  assert.strictEqual(tracker.getChangeByFilePath(source).id, state.changes[0].id);

  await tracker.stop();
  const modifiedId = tracker.getState().changes[0].id;
  fs.writeFileSync(source, "class Feature { int value = 3; }\n", "utf8");
  await assert.rejects(tracker.reject(modifiedId), /changed after capture stopped/);
  fs.writeFileSync(source, "class Feature {\n  int value = 2;\n  void Run() {}\n}\n", "utf8");
  await tracker.reject(modifiedId);
  assert.strictEqual(fs.readFileSync(source, "utf8"), "class Feature {\n  int value = 1;\n}\n");

  await tracker.start([firstRoot, secondRoot]);
  const added = path.join(secondRoot, "src", "added.ts");
  fs.writeFileSync(added, "export const added = true;\n", "utf8");
  fs.unlinkSync(secondSource);
  tracker.notifyPath(added);
  tracker.notifyPath(secondSource);
  await tracker.flush();
  state = tracker.getState();
  assert.deepStrictEqual(state.changes.map((entry) => entry.status).sort(), ["A", "D"]);
  await tracker.stop();
  const addedChange = state.changes.find((entry) => entry.status === "A");
  const deletedChange = state.changes.find((entry) => entry.status === "D");
  await tracker.reject(addedChange.id);
  await tracker.reject(deletedChange.id);
  assert.strictEqual(fs.existsSync(added), false);
  assert.strictEqual(fs.readFileSync(secondSource, "utf8"), "export const value = 1;\n");

  await tracker.start([firstRoot]);
  fs.writeFileSync(assetLibrarySource, "<ui:UXML name=\"changed\" />\n", "utf8");
  tracker.notifyPath(assetLibrarySource);
  await tracker.flush();
  const acceptedId = tracker.getState().changes[0].id;
  await tracker.accept(acceptedId);
  assert.strictEqual(tracker.getState().changes.length, 0);

  await tracker.dispose();
  fs.rmSync(temp, { recursive: true, force: true });
  console.log("codex change tracker selftest: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
